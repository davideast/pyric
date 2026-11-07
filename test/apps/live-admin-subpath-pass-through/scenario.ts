/**
 * A full-stack app's Node backend that verifies App Check tokens with
 * `firebase-admin/app-check` and sends pushes with `firebase-admin/messaging`
 * under `node --import @pyric/live/register`, as #2445 reports it. Live mode
 * observes neither, so the app lists both in `pyricLive({ passThrough })`:
 * each loads in the backend unobserved, with the backend's own credential.
 *
 * - The dev server's start line names each one, and its health report lists
 *   them in the Admin field, apart from the page's pass-through list.
 * - The backend's start line names each one. Its App Check verification
 *   fetches the public keys from `firebaseappcheck.googleapis.com` and its
 *   send reaches `fcm.googleapis.com`: the guard lets the Admin SDK's own
 *   requests to those hosts through, and refuses the backend's own.
 * - Without the list the backend's import is refused, naming the entry that
 *   would load it, and a list naming a subpath live mode serves, such as
 *   `firebase-admin/auth`, stops the dev server at start.
 *
 * The Admin SDK's Agent sends each request to a local stand-in for Google,
 * and `trap.mjs` fails every other host lookup: no request reaches a real
 * host.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scenario, type App, type ExpectedCrash } from '../driver.ts';

const PROJECT = 'demo-admin-subpaths';
const PASSED = ['firebase-admin/app-check', 'firebase-admin/messaging'];
const GUARD_BLOCKED = 'PYRIC_GUARD_BLOCKED';
/** Node 23 or later serves the Admin rows; on Node 22 every firebase-admin import is refused, so the backend's steps don't apply. */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function subpathLine(entry: string, specifier: string): RegExp {
  return new RegExp(escaped(`${entry}: ${specifier} passes through for Node processes under @pyric/live/register.`));
}

/** What the backend's calls got, from its `OUTCOME` line. */
function jobOutcome(output: string): Record<string, unknown> {
  const line = output.split('\n').find((text) => text.startsWith('OUTCOME '));
  assert.ok(line, `the backend printed its outcome:\n${output}`);
  return JSON.parse(line.slice('OUTCOME '.length)) as Record<string, unknown>;
}

function runBackend(app: App) {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  return app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], { timeoutMs: 60_000 });
}

async function liveHealth(url: string): Promise<Record<string, unknown>> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { live?: Record<string, unknown> };
  assert.ok(health.live, 'the dev server reports live status');
  return health.live;
}

export const expectedCrashes: ExpectedCrash[] = [{
  message: /^Error: @pyric\/live: firebase-admin\/(app-check|messaging) \(the Admin SDK\) is refused in live mode\./,
  source: /^command \d+ \(node --import @pyric\/live\/register server\.mjs\)$/,
  reason: 'the step that starts the dev server without passThrough runs the backend, whose first unlisted Admin import is refused at load',
}];

export default scenario(async (app) => {
  const host = await app.step('start vite dev with the two Admin subpaths in passThrough: the start line names each', async () => {
    const started = await app.devServer();
    for (const specifier of PASSED) await started.process.waitForLog(subpathLine('@pyric/live/vite', specifier));
    return started;
  });

  await app.step('the health report lists them in its Admin field, and the page list stays empty', async () => {
    const live = await liveHealth(host.url);
    assert.deepEqual(live.admin, { mode: 'observed', observed: true, bypassesRules: true, passThrough: PASSED });
    assert.equal(live.passThrough, undefined);
  });

  await app.step("the backend verifies an App Check token and sends a push through firebase-admin, and its own requests to those hosts are refused", async () => {
    if (!ADMIN_ROWS_ON) return;
    const run = await runBackend(app);
    assert.equal(run.code, 0, run.output);
    assert.doesNotMatch(run.output, /PYRIC_LIVE_REFUSED/);
    for (const specifier of PASSED) assert.match(run.output, subpathLine('@pyric/live/register', specifier));
    assert.deepEqual(jobOutcome(run.output), {
      appCheck: '1:123456789012:web:0a1b2c3d4e5f6071',
      messaging: `projects/${PROJECT}/messages/stand-in-1`,
      ownAppCheck: GUARD_BLOCKED,
      ownFcm: GUARD_BLOCKED,
      trapped: [],
    });
  });

  await app.step('stop the dev server', () => host.process.stop());

  await app.step("without the list, the backend's Admin import is refused, naming the passThrough entry that loads it", async () => {
    if (!ADMIN_ROWS_ON) return;
    const refusing = await app.devServer({ env: { PASS_THROUGH: '[]' } });
    const run = await runBackend(app);
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /firebase-admin\/(app-check|messaging) \(the Admin SDK\) is refused in live mode/);
    assert.match(run.output, /pyricLive\(\{ passThrough: \['firebase-admin\/(app-check|messaging)'\] \}\)/);
    await refusing.process.stop();
  });

  await app.step('a list naming an Admin subpath live mode serves stops the dev server at start', async () => {
    const port = await app.freePort();
    const env = { PASS_THROUGH: JSON.stringify(['firebase-admin/auth']) };
    const run = await app.command('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, timeoutMs: 60_000 });
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /passThrough lists firebase-admin\/auth, an Admin SDK subpath; live mode already serves and observes firebase-admin/);
  });
});
