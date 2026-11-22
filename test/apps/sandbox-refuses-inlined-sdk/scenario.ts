// Integration coverage for #1629 and #1531 through packed @pyric/cli entry points:
// - #1629: `pyric sandbox` refuses a dist that inlines the real Firebase SDK in
//   (control) `assets/index.js`, (a) a 260-file `assets/` directory,
//   (b) a 6-directory-deep Next static export path, and (c) an inline `<script>`
//   in `index.html`, and warns on stderr when a clean dist exceeds the
//   scanner's directory-depth or file-count limits.
// - #1531: the standalone `runDirect()` CLI path (`globalThis.__PYRIC_EMBEDDED__`)
//   refuses `PYRIC_AI_MODE=production` at startup naming `@pyric/cli` instead of
//   serving wrappers whose `/__pyric/sdk/firebase-sdk-*.js` imports 404.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../driver.ts';

const FINGERPRINT_LINE = 'const DEFAULT_HOST="firestore.googleapis.com";\n';

function makeDist(appDir: string, subdir: string): string {
  const dist = join(appDir, subdir);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(appDir, 'firebase.json'), JSON.stringify({ hosting: { public: subdir } }));
  return dist;
}

export default scenario(async (app) => {
  await app.step('control: refuses assets/index.js bundling the real Firebase SDK', async () => {
    const dist = makeDist(app.dir, 'dist-control');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'index.js'), FINGERPRINT_LINE);
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /assets\/index\.js bundles the real Firebase SDK/);
  });

  await app.step('case (a): refuses a 260-file assets/ directory with the SDK in the last file (#1629)', async () => {
    const dist = makeDist(app.dir, 'dist-260');
    const assets = join(dist, 'assets');
    mkdirSync(assets, { recursive: true });
    for (let i = 0; i < 259; i += 1) {
      writeFileSync(join(assets, `chunk-${String(i).padStart(4, '0')}.js`), 'export const chunk = 1;\n');
    }
    writeFileSync(join(assets, 'zzzz-last.js'), FINGERPRINT_LINE);
    const rawOrder = readdirSync(assets);
    const rawLast = rawOrder[rawOrder.length - 1];
    if (rawLast !== undefined && rawOrder.indexOf('zzzz-last.js') < 200) {
      writeFileSync(join(assets, rawLast), FINGERPRINT_LINE);
    }
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /bundles the real Firebase SDK/);
  });

  await app.step('case (b): refuses 6-directory-deep _next/static/chunks/app/blog/[slug]/page.js (#1629)', async () => {
    const dist = makeDist(app.dir, 'dist-depth6');
    const deep = join(dist, '_next', 'static', 'chunks', 'app', 'blog', '[slug]');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'page.js'), FINGERPRINT_LINE);
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /_next\/static\/chunks\/app\/blog\/\[slug\]\/page\.js bundles the real Firebase SDK/);
  });

  await app.step('case (c): refuses an inline <script> in index.html bundling the real Firebase SDK (#1629)', async () => {
    const dist = makeDist(app.dir, 'dist-html');
    writeFileSync(
      join(dist, 'index.html'),
      `<!doctype html><html><body><script type="module" data-src="/noop.js" data-type="application/json">${FINGERPRINT_LINE}</script></body></html>`,
    );
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /index\.html bundles the real Firebase SDK/);
  });

  await app.step('warns when a clean dist stops early at the directory depth limit (#1629)', async () => {
    const dist = makeDist(app.dir, 'dist-warn-depth');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    let deep = dist;
    for (let i = 1; i <= 18; i += 1) {
      deep = join(deep, `d${i}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'clean.js'), 'export const clean = true;\n');

    const host = await app.sandboxServer();
    try {
      assert.match(
        host.process.output,
        /inlined-SDK scan of dist-warn-depth stopped early at its directory depth limit/,
      );
    } finally {
      await host.process.stop();
    }
  });

  await app.step('warns when a clean dist stops early at the file limit (#1629)', async () => {
    const dist = makeDist(app.dir, 'dist-warn-files');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const assets = join(dist, 'assets');
    mkdirSync(assets, { recursive: true });
    for (let i = 0; i < 1_005; i += 1) {
      writeFileSync(join(assets, `c-${String(i).padStart(4, '0')}.js`), 'export const ok = 1;\n');
    }

    const host = await app.sandboxServer();
    try {
      assert.match(
        host.process.output,
        /inlined-SDK scan of dist-warn-files stopped early at its file limit \(1000 files\)/,
      );
    } finally {
      await host.process.stop();
    }
  });

  await app.step('standalone CLI entry refuses PYRIC_AI_MODE=production at startup naming @pyric/cli (#1531)', async () => {
    const dist = makeDist(app.dir, 'dist-standalone');
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    const port = await app.freePort();
    const standaloneRunner = join(app.dir, 'run-standalone-entry.mjs');
    writeFileSync(
      standaloneRunner,
      [
        'const encode = (s) => Buffer.from(s, "utf8").toString("base64");',
        'globalThis.__PYRIC_EMBEDDED__ = {',
        '  version: "0.0.0-standalone-e2e",',
        '  assetVersion: "e2e1531",',
        '  workerVersion: "w1531",',
        '  sdk: async () => ({ "app.js": encode("// app"), "worker.js": encode("// worker"), "init.js": encode("// init") }),',
        '  site: async () => ({}),',
        '};',
        'const cli = await import("./node_modules/@pyric/cli/dist/cli/index.js");',
        'await cli.runDirect();',
      ].join('\n'),
    );
    try {
      const result = await app.command(
        'node',
        [standaloneRunner, 'sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)],
        { env: { PYRIC_AI_MODE: 'production' } },
      );
      assert.equal(result.code, 2, result.output);
      assert.match(result.output, /standalone pyric binary/);
      assert.match(result.output, /@pyric\/cli/);
    } finally {
      unlinkSync(standaloneRunner);
    }
  });
});
