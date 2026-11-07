/**
 * A full-stack app's Node backend under `node --import @pyric/live/register`,
 * as #2445 reports it: the backend loads request instrumentation that wraps
 * `https.request`, then uses firebase-admin with the app's own credentials.
 * In live mode pyric observes and never blocks at the network (ADR 0022,
 * amendment 2026-11-07), so the backend runs as it would without pyric:
 *
 * - firebase-admin's token exchanges work under a wrapper installed by
 *   assignment and under one installed with `defineProperty`, as shimmer
 *   installs it;
 * - a custom credential's `getAccessToken` makes its own requests, which go
 *   out;
 * - the backend's own calls to Vertex AI, Cloud Trace and App Check's public
 *   keys go out;
 * - a firebase-admin service no row serves loads;
 * - a Messaging send on the live project goes out, observed by its row.
 *
 * Each Google host no row observes gets one "unobserved" line, and the
 * process health lists it, with the Admin subpath no row serves and App
 * Check, whose row gates its calls but records none. The project gate still
 * holds: the live project's regional Realtime Database instance and the
 * instance firebase.json names open, and `<project>-prod-default-rtdb`,
 * another project's instance, an instance firebase.json doesn't name, and
 * another project's Admin calls, App Check's among them, are refused before
 * any request.
 *
 * The Admin SDK's Agent sends its requests to a local stand-in for Google.
 * Every other connection reaches the scenario's trap (`trap.mjs`), which
 * fails its host lookup: no request reaches a real host.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scenario, type App } from '../driver.ts';

const PROJECT = 'demo-instrumented-backend';
const ENTRY = '@pyric/live/register';
/** Node 23 or later serves the Admin rows; on Node 22 every firebase-admin import is refused, so the backend's steps don't apply. */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

/** The Google hosts the backend calls that no row observes. */
const UNOBSERVED = [
  'cloudtrace.googleapis.com',
  'firebaseappcheck.googleapis.com',
  'iamcredentials.googleapis.com',
  'oauth2.googleapis.com',
  'us-central1-aiplatform.googleapis.com',
  'www.googleapis.com',
];

/** What a backend job's calls got, from its `OUTCOME` line. */
function jobOutcome(output: string): Record<string, unknown> {
  const line = output.split('\n').find((text) => text.startsWith('OUTCOME '));
  assert.ok(line, `the backend printed its outcome:\n${output}`);
  return JSON.parse(line.slice('OUTCOME '.length)) as Record<string, unknown>;
}

/** How many times the output names `host` as unobserved. */
function unobservedLines(output: string, host: string): number {
  return output.split(`${ENTRY}: unobserved call to ${host} (`).length - 1;
}

/** Runs the backend under the live register, from the app's project, with its instrumentation installed as `instrument` says. */
function runBackend(app: App, instrument: 'assign' | 'define') {
  return app.command('node', ['--import', ENTRY, 'server.mjs'], { env: { INSTRUMENT: instrument }, timeoutMs: 90_000 });
}

/** One run's checks: everything goes out, each unobserved host is named once, and the project gate holds. */
async function checkBackend(app: App, instrument: 'assign' | 'define'): Promise<void> {
  const run = await runBackend(app, instrument);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, new RegExp(`${ENTRY}: live mode for the Firebase project ${PROJECT}\\.`));
  assert.doesNotMatch(run.output, /PYRIC_GUARD_BLOCKED|net-guard BLOCK/);
  const { trapped, health, callbackRequests, ...outcome } = jobOutcome(run.output);
  assert.deepEqual(outcome, {
    instrument,
    adcLookup: 'order-owner',
    tokenExchanges: 1,
    instrumented: true,
    callbackLookup: 'order-owner',
    vertex: 'SCENARIO_TRAP',
    trace: 'SCENARIO_TRAP',
    jwks: 'SCENARIO_TRAP',
    remoteConfig: 'loaded',
    messagingSend: 'ok',
    ownInstance: 'ok',
    otherInstance: 'PYRIC_LIVE_REFUSED',
    listedInstance: 'ok',
    unlistedInstance: 'PYRIC_LIVE_REFUSED',
    otherProjectLookup: 'PYRIC_LIVE_REFUSED',
    otherProjectAppCheck: 'PYRIC_LIVE_REFUSED',
    otherProjectSent: 0,
  });
  // The custom credential's https.request reached the stand-in, and its fetch reached the trap: neither was refused.
  assert.deepEqual([...new Set(callbackRequests as string[])].sort(), ['SCENARIO_TRAP', 'sent']);
  // The service-account exchange and the backend's own fetches went out; the other project's instance never did.
  const trappedHosts = trapped as string[];
  for (const host of ['www.googleapis.com', 'us-central1-aiplatform.googleapis.com', 'cloudtrace.googleapis.com', 'firebaseappcheck.googleapis.com']) {
    assert.ok(trappedHosts.includes(host), `${host} went out: ${trappedHosts.join(', ')}`);
  }
  for (const refused of [`${PROJECT}-prod-default-rtdb.firebaseio.com`, `${PROJECT}-shard-02.firebaseio.com`]) {
    assert.ok(!trappedHosts.includes(refused), `the refused instance ${refused} opened no connection`);
  }
  for (const host of UNOBSERVED) assert.equal(unobservedLines(run.output, host), 1, `one line for ${host}:\n${run.output}`);
  assert.equal(unobservedLines(run.output, 'identitytoolkit.googleapis.com'), 0, 'the Auth row observes its lookups');
  assert.equal(unobservedLines(run.output, 'fcm.googleapis.com'), 0, 'the Messaging row observes its sends');
  assert.match(run.output, new RegExp(`${ENTRY}: firebase-admin/remote-config loads unobserved\\.`));
  for (const served of ['messaging', 'app-check']) {
    assert.doesNotMatch(run.output, new RegExp(`firebase-admin/${served} loads unobserved`), `a row serves firebase-admin/${served}`);
  }
  const { unobserved, unobservedAdmin, gatedAdmin, ...process } = health as { unobserved: string[]; unobservedAdmin: string[]; gatedAdmin: string[] };
  assert.deepEqual(process, { mode: 'live', projectId: PROJECT });
  assert.deepEqual([...unobserved].sort(), UNOBSERVED);
  assert.deepEqual(unobservedAdmin, ['firebase-admin/remote-config']);
  assert.deepEqual(gatedAdmin, ['firebase-admin/app-check']);
}

export default scenario(async (app) => {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  // The live project's second Realtime Database instance, which live mode lets through because firebase.json names it.
  app.writeFile('firebase.json', `${JSON.stringify({ database: [{ instance: `${PROJECT}-shard-01`, rules: 'database.rules.json' }] })}\n`);
  app.writeFile('database.rules.json', `${JSON.stringify({ rules: { '.read': false, '.write': false } })}\n`);
  const host = await app.step('start vite dev with pyricLive()', () => app.devServer());

  if (!ADMIN_ROWS_ON) {
    await app.step('stop the dev server', () => host.process.stop());
    return;
  }

  await app.step('under a wrapper installed by assignment, the backend runs as it would without pyric, and names what no row observes', () =>
    checkBackend(app, 'assign'));

  await app.step('under a wrapper installed with defineProperty, as shimmer installs it, the same holds', () => checkBackend(app, 'define'));

  await app.step('stop the dev server', () => host.process.stop());
});
