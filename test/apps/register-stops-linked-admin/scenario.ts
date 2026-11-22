// #1620: `@pyric/cli/register` stops loads of the real `firebase-admin` even
// when its resolved file path lies outside `node_modules` (a vendored copy
// linked under an alias in `node_modules`, or a link outside `node_modules`
// run with `--preserve-symlinks`).
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../driver.ts';

interface ProbeOutcome {
  readonly status: 'swapped' | 'real firebase-admin' | 'stopped';
  readonly code: string | null;
  readonly message: string | null;
}

function parseOutcome(output: string): ProbeOutcome {
  const match = /^(?:\[dev\] )?OUTCOME (\{.*\})$/m.exec(output);
  assert.ok(match !== null && match[1] !== undefined, `expected an OUTCOME line:\n${output}`);
  return JSON.parse(match[1]) as ProbeOutcome;
}

export default scenario(async (app) => {
  const installedAdminDir = join(app.dir, 'node_modules', 'firebase-admin');
  const vendorAdminDir = join(app.dir, 'vendor', 'firebase-admin');
  mkdirSync(join(app.dir, 'vendor'), { recursive: true });
  cpSync(installedAdminDir, vendorAdminDir, { recursive: true, dereference: true });
  symlinkSync('../vendor/firebase-admin', join(app.dir, 'node_modules', 'admin'));
  symlinkSync(installedAdminDir, join(app.dir, 'linked-admin'));

  await app.step('stops a vendored firebase-admin copy outside node_modules imported via a node_modules alias', async () => {
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--port', String(port), '--', 'node', 'probe.mjs', 'admin/app']);
    assert.equal(result.code, 0, result.output);
    const outcome = parseOutcome(result.output);
    assert.equal(outcome.status, 'stopped', result.output);
    assert.equal(outcome.code, 'PYRIC_REAL_SDK_STOPPED', result.output);
    assert.ok(outcome.message?.includes('stopped loading the real firebase-admin'), result.output);
    assert.ok(outcome.message?.includes('/vendor/firebase-admin/'), result.output);
  });

  await app.step('stops a symlinked firebase-admin outside node_modules under --preserve-symlinks', async () => {
    const port = await app.freePort();
    const result = await app.pyric([
      'sandbox',
      '--no-open',
      '--port',
      String(port),
      '--',
      'node',
      '--preserve-symlinks',
      'probe.mjs',
      './linked-admin/lib/app/index.js',
    ]);
    assert.equal(result.code, 0, result.output);
    const outcome = parseOutcome(result.output);
    assert.equal(outcome.status, 'stopped', result.output);
    assert.equal(outcome.code, 'PYRIC_REAL_SDK_STOPPED', result.output);
    assert.ok(outcome.message?.includes('stopped loading the real firebase-admin'), result.output);
    assert.ok(outcome.message?.includes('/linked-admin/lib/app/index.js'), result.output);
  });

  await app.step('still swaps canonical firebase-admin/app imports in the same project', async () => {
    const port = await app.freePort();
    const result = await app.pyric(['sandbox', '--no-open', '--port', String(port), '--', 'node', 'probe.mjs', 'firebase-admin/app']);
    assert.equal(result.code, 0, result.output);
    const outcome = parseOutcome(result.output);
    assert.equal(outcome.status, 'swapped', result.output);
  });
});
