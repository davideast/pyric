/**
 * End-to-end installed-tarball scenario covering CLI messages, hints, and
 * hot-reload behavior (#1259, #1201, #1197, #1189):
 * - `--hosted` startup banner shows MCP endpoint without contradictory
 *   `re-run with --bridge` tip (#1189).
 * - Reloading rules before any captured session exists omits the verify hint
 *   without spending it (#1259).
 * - Running `pyric database rules generate` reloads `database.rules.json`
 *   without spending the verify hint, and prints runnable `npx pyric verify`
 *   guidance (#1259, #1201).
 * - A subsequent user edit to `database.rules.json` prints the `npx pyric verify`
 *   hint once for database, and a user edit to `firestore.rules` prints it once
 *   for Firestore (#1259, #1201).
 * - `pyric snapshot --out pyric-carryover.json` writes a single JSON file (not
 *   a directory) and prints runnable `npx pyric sandbox --seed` guidance (#1197, #1201).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep } from '../driver.ts';

interface CapturedFixture {
  events?: unknown[];
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const pointerPath = join(app.dir, '.pyric', 'serve.json');
  const capturePath = join(app.dir, '.pyric', 'last-session.json');

  const host = await app.step('start the hosted sandbox server and check banner', async () => {
    const proc = app.pyricProcess([
      'sandbox',
      '--hosted',
      '--no-open',
      '--no-run',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ]);
    const deadline = Date.now() + 60_000;
    while (!existsSync(pointerPath) || !proc.output.includes('PYRIC_SANDBOX=remote')) {
      if (Date.now() > deadline) {
        throw new Error(`sandbox server did not finish startup:\n${proc.output}`);
      }
      await sleep(100);
    }
    await sleep(200);
    assert.ok(proc.output.includes('MCP endpoint:'), proc.output);
    assert.equal(proc.output.includes('re-run with --bridge'), false, proc.output);
    return proc;
  });

  try {
    await app.step('reload before any captured session omits verify hint', async () => {
      const since = host.mark();
      app.writeFile(
        'database.rules.json',
        `${JSON.stringify({ rules: { '.read': true, '.write': false } }, null, 2)}\n`,
      );
      const reloadMatch = await host.waitForLog(/rtdb rules reloaded .* \(hash \w+\).*$/m, {
        since,
      });
      const reloadLine = reloadMatch[0];
      assert.equal(reloadLine.includes('pyric verify'), false, reloadLine);
    });

    await app.step('record a live sandbox operation so last-session.json is non-empty', async () => {
      const writeRes = await app.pyric([
        'database',
        'set',
        '--path',
        'items/seed',
        '--value',
        '{"ok":true}',
        '--json',
      ]);
      assert.equal(writeRes.code, 0, writeRes.output);

      const deadline = Date.now() + 15_000;
      let capturedEvents = 0;
      while (Date.now() < deadline) {
        if (existsSync(capturePath)) {
          const parsed = JSON.parse(readFileSync(capturePath, 'utf8')) as CapturedFixture;
          if (Array.isArray(parsed.events) && parsed.events.length > 0) {
            capturedEvents = parsed.events.length;
            break;
          }
        }
        await sleep(100);
      }
      assert.ok(capturedEvents > 0, 'expected captured events in .pyric/last-session.json');
    });

    await app.step('generated rules write reloads without spending the verify hint', async () => {
      const since = host.mark();
      const generated = await app.pyric([
        'database',
        'rules',
        'generate',
        '--config',
        'database.rules.mjs',
        '--out',
        'database.rules.json',
      ]);
      assert.equal(generated.code, 0, generated.output);
      assert.ok(
        generated.output.includes(
          'Test before deploy: npx pyric verify --service rtdb --rules rtdb=database.rules.json',
        ),
        generated.output,
      );

      const reloadMatch = await host.waitForLog(/rtdb rules reloaded .* \(hash \w+\).*$/m, {
        since,
      });
      const reloadLine = reloadMatch[0];
      assert.equal(reloadLine.includes('pyric verify'), false, reloadLine);
    });

    await app.step('first user edit per service prints npx pyric verify once', async () => {
      const sinceDbFirst = host.mark();
      app.writeFile(
        'database.rules.json',
        `${JSON.stringify({ rules: { items: { '.read': 'auth != null', '.write': 'auth != null' } } }, null, 2)}\n`,
      );
      const dbFirstMatch = await host.waitForLog(/rtdb rules reloaded .* \(hash \w+\).*$/m, {
        since: sinceDbFirst,
      });
      const dbFirstLine = dbFirstMatch[0];
      assert.ok(
        dbFirstLine.includes('(run `npx pyric verify` to replay the captured session against these rules)'),
        dbFirstLine,
      );

      const sinceDbSecond = host.mark();
      app.writeFile(
        'database.rules.json',
        `${JSON.stringify({ rules: { items: { '.read': true, '.write': false } } }, null, 2)}\n`,
      );
      const dbSecondMatch = await host.waitForLog(/rtdb rules reloaded .* \(hash \w+\).*$/m, {
        since: sinceDbSecond,
      });
      const dbSecondLine = dbSecondMatch[0];
      assert.equal(dbSecondLine.includes('pyric verify'), false, dbSecondLine);

      const sinceFsFirst = host.mark();
      app.writeFile(
        'firestore.rules',
        [
          "rules_version = '2';",
          'service cloud.firestore {',
          '  match /databases/{database}/documents {',
          '    match /items/{id} {',
          '      allow read: if request.auth != null;',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      const fsFirstMatch = await host.waitForLog(/(?<!rtdb )rules reloaded \(hash \w+\).*$/m, {
        since: sinceFsFirst,
      });
      const fsFirstLine = fsFirstMatch[0];
      assert.ok(
        fsFirstLine.includes('(run `npx pyric verify` to replay the captured session against these rules)'),
        fsFirstLine,
      );
    });

    await app.step('snapshot --out file.json writes a single JSON file with npx hint', async () => {
      const snap = await app.pyric(['snapshot', '--out', 'pyric-carryover.json']);
      assert.equal(snap.code, 0, snap.output);
      const carryoverPath = join(app.dir, 'pyric-carryover.json');
      assert.equal(statSync(carryoverPath).isFile(), true);
      assert.equal(existsSync(join(carryoverPath, 'state.json')), false);
      assert.ok(
        snap.output.includes('Re-serve it: npx pyric sandbox --seed pyric-carryover.json'),
        snap.output,
      );
    });
  } finally {
    await host.stop();
  }
});
