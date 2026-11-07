/**
 * A full-stack app's Node backend under `node --import @pyric/live/register`,
 * as #2445 reports it: the backend loads request instrumentation that wraps
 * `https.request` (as OpenTelemetry's HTTP instrumentation or an APM agent
 * does), then uses firebase-admin with the app's own credentials.
 *
 * The live guard lets firebase-admin's own token exchanges through, from
 * Application Default Credentials and from a service-account key, though
 * the instrumentation's wrapper sits between them and the runtime. The
 * backend's own request to the token endpoint, through the same wrapper, is
 * still refused.
 *
 * The Admin SDK's Agent sends its requests to a local stand-in for Google,
 * and the guard still judges each one by the Google host it names. The
 * service-account exchange ignores that Agent, so the scenario's trap
 * (`trap.mjs`) fails its host lookup after the guard lets it out: no request
 * reaches a real host.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scenario, type App } from '../driver.ts';

const PROJECT = 'demo-instrumented-backend';
const GUARD_BLOCKED = 'PYRIC_GUARD_BLOCKED';
/** Node 23 or later serves the Admin rows; on Node 22 every firebase-admin import is refused, so the backend's steps don't apply. */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

/** What a backend job's calls got, from its `OUTCOME` line. */
function jobOutcome(output: string): Record<string, unknown> {
  const line = output.split('\n').find((text) => text.startsWith('OUTCOME '));
  assert.ok(line, `the backend printed its outcome:\n${output}`);
  return JSON.parse(line.slice('OUTCOME '.length)) as Record<string, unknown>;
}

/** Runs a backend script under the live register, from the app's project, as the report runs it. */
function runBackend(app: App, script: string) {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  return app.command('node', ['--import', '@pyric/live/register', script], { timeoutMs: 60_000 });
}

export default scenario(async (app) => {
  const host = await app.step('start vite dev with pyricLive()', () => app.devServer());

  await app.step("an instrumented backend's firebase-admin gets its own tokens, and the backend's own token request is refused", async () => {
    if (!ADMIN_ROWS_ON) return;
    const run = await runBackend(app, 'server.mjs');
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.doesNotMatch(run.output, /net-guard BLOCK www\.googleapis\.com/);
    assert.deepEqual(jobOutcome(run.output), {
      adcLookup: 'order-owner',
      tokenExchanges: 1,
      trapped: ['www.googleapis.com'],
      instrumented: true,
      ownTokenRequest: GUARD_BLOCKED,
    });
  });

  await app.step('stop the dev server', () => host.process.stop());
});
