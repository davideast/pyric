// End-to-end verification for #1446: realpath containment across MCP path
// arguments (sandbox.exportFixture, storage.uploadBytes), the static server,
// and `pyric firestore rules resolve` for 2+modules imports.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { scenario, type App } from '../driver.ts';

async function mcpCall(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const { code, output } = await app.command('node', ['mcp-call.mjs', name, JSON.stringify(args)], {
    timeoutMs: 60_000,
  });
  assert.equal(code, 0, output);
  const line = output.split('\n').find((entry) => entry.startsWith('result '));
  assert.ok(line, `no result line in:\n${output}`);
  return JSON.parse(line.slice('result '.length)) as { isError: boolean; text: string };
}

export default scenario(async (app) => {
  const outside = mkdtempSync(join(tmpdir(), 'pyric-symlink-escape-outside-'));
  try {
    const outsideSecret = join(outside, 'secret.txt');
    const outsideExport = join(outside, 'export.json');
    const outsideRules = join(outside, 'outside.rules');
    writeFileSync(outsideSecret, 'OUTSIDE_SECRET_PAYLOAD', 'utf8');
    writeFileSync(outsideExport, 'KEEP_INTACT', 'utf8');
    writeFileSync(
      outsideRules,
      "rules_version = '2+modules';\nexport function leaked() { return true; }\n",
      'utf8',
    );

    symlinkSync(outsideExport, join(app.dir, 'escape-export.json'));
    symlinkSync(outside, join(app.dir, 'escape-dir'));
    symlinkSync(outsideSecret, join(app.dir, 'escape-read.txt'));
    symlinkSync(outsideSecret, join(app.dir, 'public', 'escape.txt'));
    mkdirSync(join(app.dir, 'public', 'escaped-dir'), { recursive: true });
    symlinkSync(outsideSecret, join(app.dir, 'public', 'escaped-dir', 'index.html'));
    symlinkSync(join(app.dir, 'public', 'hello.txt'), join(app.dir, 'public', 'internal.txt'));
    symlinkSync(outsideRules, join(app.dir, 'escape-mod.rules'));

    await app.step('pyric mcp refuses sandbox.exportFixture through escaping symlinks', async () => {
      const fileEscape = await mcpCall(app, 'sandbox', {
        method: 'exportFixture',
        args: { path: 'escape-export.json' },
      });
      assert.equal(fileEscape.isError, true, fileEscape.text);
      assert.match(fileEscape.text, /escape-export\.json/);
      assert.match(fileEscape.text, /outside the project directory/);
      assert.equal(readFileSync(outsideExport, 'utf8'), 'KEEP_INTACT');

      const dirEscape = await mcpCall(app, 'sandbox', {
        method: 'exportFixture',
        args: { path: 'escape-dir/new-export.json' },
      });
      assert.equal(dirEscape.isError, true, dirEscape.text);
      assert.match(dirEscape.text, /escape-dir\/new-export\.json/);
      assert.match(dirEscape.text, /outside the project directory/);
      assert.equal(existsSync(join(outside, 'new-export.json')), false);
    });

    await app.step('pyric mcp refuses storage.uploadBytes sourcePath through escaping symlink', async () => {
      const readEscape = await mcpCall(app, 'storage', {
        method: 'uploadBytes',
        args: { path: 'uploads/leak.txt', sourcePath: 'escape-read.txt' },
      });
      assert.equal(readEscape.isError, true, readEscape.text);
      assert.match(readEscape.text, /escape-read\.txt/);
      assert.match(readEscape.text, /outside the project directory/);
    });

    await app.step('pyric sandbox static server refuses escaping symlinks and serves internal symlink', async () => {
      const sandbox = await app.sandboxServer();
      try {
        const escaped = await fetch(`${sandbox.url}/escape.txt`);
        assert.equal(escaped.status, 404);
        assert.doesNotMatch(await escaped.text(), /OUTSIDE_SECRET_PAYLOAD/);

        const escapedIndex = await fetch(`${sandbox.url}/escaped-dir/`);
        assert.equal(escapedIndex.status, 404);
        assert.doesNotMatch(await escapedIndex.text(), /OUTSIDE_SECRET_PAYLOAD/);

        const internal = await fetch(`${sandbox.url}/internal.txt`);
        assert.equal(internal.status, 200);
        assert.match(await internal.text(), /inside public/);
      } finally {
        await sandbox.process.stop();
      }
    });

    await app.step('pyric firestore rules resolve refuses .. and symlink imports leaving the source directory', async () => {
      const rulesDir = join(app.dir, 'rules');
      mkdirSync(rulesDir, { recursive: true });
      const relOutside = relative(rulesDir, join(outside, 'outside')).split('\\').join('/');
      const traversalSpec = relOutside.startsWith('.') ? relOutside : `./${relOutside}`;
      writeFileSync(
        join(rulesDir, 'traversal.rules'),
        `rules_version = '2+modules';\nimport { leaked } from '${traversalSpec}';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if leaked(); }\n  }\n}\n`,
        'utf8',
      );
      const traversalRun = await app.pyric(['firestore', 'rules', 'resolve', 'rules/traversal.rules']);
      assert.notEqual(traversalRun.code, 0, traversalRun.output);
      assert.match(traversalRun.output, /not found/i);
      assert.ok(traversalRun.output.includes(traversalSpec), traversalRun.output);

      writeFileSync(
        join(app.dir, 'symlink-import.rules'),
        "rules_version = '2+modules';\nimport { leaked } from './escape-mod';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if leaked(); }\n  }\n}\n",
        'utf8',
      );
      const symlinkRun = await app.pyric(['firestore', 'rules', 'resolve', 'symlink-import.rules']);
      assert.notEqual(symlinkRun.code, 0, symlinkRun.output);
      assert.match(symlinkRun.output, /not found/i);
      assert.match(symlinkRun.output, /\.\/escape-mod/);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
