// ADR-0022, decision 2: a process `pyric sandbox` starts can't get a
// server-side Google access token, and every other host passes. The probes
// run under `pyric sandbox -- node <probe>` with PYRIC_GUARD unset, a fresh
// HOME and CLOUDSDK_CONFIG, and a placeholder authorized_user file as the only
// credential:
//   - google-auth-library's getAccessToken() fails with PYRIC_GUARD_BLOCKED;
//   - gcp-metadata's metadata server lookups fail with PYRIC_GUARD_BLOCKED;
//   - a Google Fonts request passes the guard;
//   - in production AI mode, the Firebase SDK's firebase/ai passes the guard.
// Before the change the default guard (`warn`) let the refresh-token exchange
// through to oauth2.googleapis.com and the metadata server lookups through to
// 169.254.169.254, and the trap caught both (#1475, #1499).
//
// trap.mjs loads ahead of the register and sends every connection the guard
// lets through to a closed local port, so nothing reaches the network either
// way.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scenario, type App } from '../driver.ts';

const BLOCKED = 'PYRIC_GUARD_BLOCKED';

/** Hosts a token comes from. None of them may reach the trap. */
const TOKEN_HOSTS = ['oauth2.googleapis.com', 'sts.googleapis.com', 'iamcredentials.googleapis.com', '169.254.169.254', 'metadata.google.internal', 'metadata.google.internal.'];

interface ProbeReport {
  name: string;
  results: Record<string, unknown>;
  trapped: string[];
  guard: string | null;
}

/** Runs one probe under `pyric sandbox --hosted -- node <probe>` and returns its report and the launcher's output. */
async function runProbe(app: App, probe: string, env: Record<string, string> = {}): Promise<{ report: ProbeReport; output: string }> {
  const sandboxPort = await app.freePort();
  const closedPort = await app.freePort();
  const result = await app.pyric(['sandbox', '--hosted', '--no-open', '--port', String(sandboxPort), '--', 'node', probe], {
    env: {
      PYRIC_NO_UPDATE_CHECK: '1',
      NODE_OPTIONS: `--import ${pathToFileURL(join(app.dir, 'trap.mjs')).href}`,
      SCENARIO_CLOSED_PORT: String(closedPort),
      GOOGLE_APPLICATION_CREDENTIALS: join(app.dir, 'authorized-user.json'),
      ...env,
    },
    timeoutMs: 90_000,
  });
  assert.equal(result.code, 0, result.output);
  const line = /^PROBE (.*)$/m.exec(result.output);
  assert.ok(line, `${probe} printed no result:\n${result.output}`);
  return { report: JSON.parse(line[1]!) as ProbeReport, output: result.output };
}

export default scenario(async (app) => {
  const credentials = await app.step('run the credential probes under pyric sandbox with PYRIC_GUARD unset', () =>
    runProbe(app, 'probe.mjs'));

  await app.step('the probe ran under the register, with the trap in place', () => {
    assert.notEqual(credentials.report.guard, null, credentials.output);
    assert.ok(Array.isArray(credentials.report.trapped), credentials.output);
  });

  await app.step("google-auth-library's getAccessToken() is refused", () => {
    assert.equal(credentials.report.results.getAccessToken, BLOCKED, credentials.output);
    assert.match(credentials.output, /net-guard BLOCK oauth2\.googleapis\.com \(Google OAuth 2\.0 token endpoint\)/);
  });

  await app.step("gcp-metadata's metadata server lookups are refused", () => {
    assert.equal(credentials.report.results.isAvailable, false, credentials.output);
    assert.equal(credentials.report.results.instance, BLOCKED, credentials.output);
    assert.match(credentials.output, /net-guard BLOCK (169\.254\.169\.254|metadata\.google\.internal) \(GCE metadata server\)/);
  });

  await app.step('a Google Fonts request passes the guard and reaches only the trap', () => {
    assert.notEqual(credentials.report.results.fonts, BLOCKED, credentials.output);
    assert.ok(credentials.report.trapped.includes('fonts.googleapis.com'), JSON.stringify(credentials.report.trapped));
    assert.doesNotMatch(credentials.output, /net-guard (BLOCK|WARN) fonts\.googleapis\.com/);
  });

  await app.step('no token request reached the trap', () => {
    const tokenHits = credentials.report.trapped.filter((host) => TOKEN_HOSTS.includes(host));
    assert.deepEqual(tokenHits, [], credentials.output);
  });

  const ai = await app.step('run the firebase/ai probe in production AI mode', () =>
    runProbe(app, 'ai-probe.mjs', { PYRIC_AI_MODE: 'production' }));

  await app.step("the Firebase SDK's firebase/ai request passes the guard and reaches only the trap", () => {
    assert.notEqual(ai.report.results.generateContent, BLOCKED, ai.output);
    assert.ok(ai.report.trapped.includes('firebasevertexai.googleapis.com'), JSON.stringify(ai.report.trapped));
    assert.doesNotMatch(ai.output, /net-guard (BLOCK|WARN) /);
  });
});
