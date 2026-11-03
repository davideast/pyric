// ADR 0022: under `pyric sandbox`, the network guard refuses only requests
// for a server-side Google access token, by default and with no PYRIC_GUARD
// set, and lets every other host through without a report. Before, the
// default `warn` let google-auth-library exchange its credential at
// oauth2.googleapis.com and let gcp-metadata reach the GCE metadata server
// (#1475).
//
// The only credential is a fake `authorized_user` file; HOME and
// CLOUDSDK_CONFIG point at empty folders. trap.cjs, loaded before the
// register, sends every connection the guard lets through to a closed local
// port, so nothing reaches the network either way.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scenario, type App } from '../driver.ts';

const BLOCKED = 'PYRIC_GUARD_BLOCKED';

interface Outcome {
  resolved?: unknown;
  rejected?: string;
}

interface ProbeOutput {
  probe: string;
  results: Record<string, Outcome>;
  trapped: string[] | null;
}

/** Empty HOME and gcloud folders, and the fake credential, outside the app. */
function credentialEnv(app: App): Record<string, string> {
  const work = dirname(app.dir);
  const home = join(work, 'empty-home');
  const gcloud = join(work, 'empty-gcloud');
  mkdirSync(home, { recursive: true });
  mkdirSync(gcloud, { recursive: true });
  const credentials = join(work, 'authorized-user.json');
  writeFileSync(credentials, JSON.stringify({
    type: 'authorized_user',
    client_id: 'scenario-client.apps.example',
    client_secret: 'scenario-secret',
    refresh_token: 'scenario-refresh-token',
  }));
  return { HOME: home, CLOUDSDK_CONFIG: gcloud, GOOGLE_APPLICATION_CREDENTIALS: credentials };
}

async function runProbe(app: App, probe: string, env: Record<string, string>): Promise<{ output: ProbeOutput; log: string }> {
  const port = await app.freePort();
  const closedPort = await app.freePort();
  const result = await app.pyric(['sandbox', '--no-open', '--port', String(port), '--', 'node', 'probe.mjs', probe], {
    env: {
      ...env,
      NODE_OPTIONS: `--require ${join(app.dir, 'trap.cjs')}`,
      SCENARIO_CLOSED_PORT: String(closedPort),
    },
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, result.output);
  const line = result.output.split('\n').find((text) => text.startsWith('{"probe"'));
  assert.ok(line, `probe.mjs printed no result:\n${result.output}`);
  const output = JSON.parse(line) as ProbeOutput;
  assert.ok(Array.isArray(output.trapped), `trap.cjs did not load:\n${result.output}`);
  return { output, log: result.output };
}

export default scenario(async (app) => {
  const env = await app.step('write the fake credential and the empty folders', () => credentialEnv(app));

  const { output, log } = await app.step('run the credential probes under pyric sandbox with no PYRIC_GUARD', () =>
    runProbe(app, 'credentials', env));

  await app.step("google-auth-library's getAccessToken() is refused", () => {
    assert.deepEqual(output.results.accessToken, { rejected: BLOCKED }, log);
    assert.match(log, /net-guard BLOCK oauth2\.googleapis\.com \(Google OAuth 2\.0 token endpoint\)/);
  });

  await app.step('gcp-metadata finds no metadata server, because the guard refuses it', () => {
    assert.deepEqual(output.results.metadataInstance, { rejected: BLOCKED }, log);
    assert.deepEqual(output.results.metadataAvailable, { resolved: false }, log);
  });

  await app.step('a fetch to fonts.googleapis.com reaches the trap without being refused', () => {
    assert.notEqual(output.results.fonts?.rejected, BLOCKED, log);
    assert.ok(output.trapped!.includes('fonts.googleapis.com'), JSON.stringify(output.trapped));
    assert.doesNotMatch(log, /net-guard BLOCK fonts\.googleapis\.com/);
  });

  await app.step('no token request reached the trap', () => {
    assert.deepEqual([...new Set(output.trapped)], ['fonts.googleapis.com']);
  });

  const ai = await app.step('run the real firebase/ai under pyric sandbox in production AI mode', () =>
    runProbe(app, 'ai', { ...env, PYRIC_AI_MODE: 'production' }));

  await app.step('the real firebase/ai reaches the trap as firebasevertexai.googleapis.com without being refused', () => {
    assert.notEqual(ai.output.results.generate?.rejected, BLOCKED, ai.log);
    assert.ok(ai.output.trapped!.includes('firebasevertexai.googleapis.com'), `${JSON.stringify(ai.output)}\n${ai.log}`);
    assert.doesNotMatch(ai.log, /net-guard BLOCK/);
  });
});
