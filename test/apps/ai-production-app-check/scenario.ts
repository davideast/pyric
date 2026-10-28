// In production AI mode the page's firebase/app-check is the Firebase SDK,
// attached to the same app firebase/ai reads, so AI Logic requests carry the
// App Check token. A Playwright route answers Google the way AI Logic does
// (403 without a token, captured in app-check-ai-gate-wire): nothing in this
// scenario reaches a real Google endpoint.
//
// The app also sends its App Check token to its own backend, which verifies it
// with firebase-admin and answers 401 when that fails (#1552). In production
// AI mode that token comes from Firebase. The scenario signs one shaped like
// Firebase's with its own RSA key, and jwks-stand-in.mjs serves that key as
// Firebase's public keys, so firebase-admin runs unchanged and nothing leaves
// the machine.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { scenario } from '../driver.ts';

const DENIED = {
  error: {
    code: 403,
    message: 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check',
    status: 'PERMISSION_DENIED',
  },
};

interface Outcome { ok: boolean; text?: string; error?: string }
declare function runWithAppCheck(): Promise<{ token: string; outcome: Outcome }>;
declare function runAppCheckAfterAi(): Promise<Outcome>;
declare function tokenForBackend(issued: string): Promise<string>;

const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:abcdef0123456789`;
const KEY_ID = 'Wv4XNA';
const SIGNATURE = 'The provided App Check token has invalid signature.';
const NOT_SANDBOX =
  "This App Check token was not minted by the Pyric sandbox, so the sandbox's firebase-admin/app-check cannot verify it. " +
  'A page in production AI mode gets its App Check tokens from Firebase. Start this server in production AI mode too ' +
  '(PYRIC_AI_MODE=production) and Pyric verifies them with firebase-admin. In sandbox AI mode, page tokens come from the sandbox and verify here.';
const DECODED_CLAIMS = ['app_id', 'aud', 'exp', 'iat', 'iss', 'jti', 'provider', 'sub'];

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** An RS256 App Check token shaped like Firebase's, signed with the scenario's key. */
function firebaseShapedToken(privateKey: KeyObject): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const claims = {
    sub: APP_ID,
    aud: [`projects/${PROJECT_NUMBER}`, 'projects/my-real-project'],
    provider: 'recaptcha_enterprise',
    iss: `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`,
    exp: iat + 3600,
    iat,
    jti: randomBytes(24).toString('base64url'),
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

interface Verified {
  label: string;
  ok: boolean;
  appId?: string;
  claims?: string[];
  appIdClaim?: string;
  alreadyConsumed?: boolean | null;
  code?: string;
  message?: string;
  jwksRequests: number;
}
interface VerifyReport { results: Verified[]; served: string[]; refused: string[]; realAdminLoaded: boolean }

function verifyReport(output: string): VerifyReport {
  const line = output.match(/^verify (.*)$/m);
  assert.ok(line, `no verify line in:\n${output}`);
  return JSON.parse(line[1]!) as VerifyReport;
}

const verified = (label: string, extra: Partial<Verified> = {}): Verified => ({
  label,
  ok: true,
  appId: APP_ID,
  claims: DECODED_CLAIMS,
  appIdClaim: APP_ID,
  alreadyConsumed: null,
  jwksRequests: 0,
  ...extra,
});
const refused = (label: string, message: string): Verified => ({ label, ok: false, code: 'app-check/invalid-argument', message, jwksRequests: 0 });

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server in production AI mode', () =>
    app.devServer({ env: { PYRIC_AI_MODE: 'production' } }));

  const aiHeaders: (string | null)[] = [];
  const appCheckHosts: string[] = [];
  const pageRequests: string[] = [];
  await app.step('answer Google from a route, as AI Logic does', async () => {
    const context = await app.browser();
    context.on('request', (request) => pageRequests.push(request.url()));
    await context.route('https://firebasevertexai.googleapis.com/**', (route) => {
      const header = route.request().headers()['x-firebase-appcheck'] ?? null;
      aiHeaders.push(header);
      if (header === null) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(DENIED) });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }] }),
      });
    });
    await context.route('https://firebaseappcheck.googleapis.com/**', (route) => {
      appCheckHosts.push(route.request().url());
      return route.abort();
    });
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runWithAppCheck' in window);
    return page;
  });

  await app.step('initializeAppCheck then getAI: the request carries the App Check token', async () => {
    const { token, outcome } = await page.evaluate(() => runWithAppCheck());
    assert.equal(token, 'attested-by-the-app');
    assert.deepEqual(aiHeaders, ['attested-by-the-app'], `X-Firebase-AppCheck values Google saw: ${JSON.stringify(aiHeaders)}`);
    assert.deepEqual(outcome, { ok: true, text: 'pong' });
  });

  await app.step('getAI then initializeAppCheck: the earlier model sends no token and AI Logic refuses it', async () => {
    aiHeaders.length = 0;
    const outcome = await page.evaluate(() => runAppCheckAfterAi());
    assert.deepEqual(aiHeaders, [null]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /you must enforce Firebase App Check/);
  });

  await app.step('a custom provider needs no App Check endpoint', () => {
    assert.deepEqual(appCheckHosts, []);
  });

  await app.step('the dev server serves the App Check bridge, not the sandbox mirror', async () => {
    const main = await (await fetch(`${host.url}/main.js`)).text();
    assert.match(main, /app-ai-passthrough-app-check/, main.split('\n').slice(0, 4).join('\n'));
    const mirror = pageRequests.filter((url) => /\/pyric\/(?:dist|src)\/app-check\/|\/__pyric\/sdk\/app-check\.js/.test(url));
    assert.deepEqual(mirror, [], `the page loaded Pyric's App Check mirror: ${mirror.join(', ')}`);
  });

  await app.step('a registered Node process in production AI mode sends the token too', async () => {
    const result = await app.serverScript('server.mjs', [], { env: { PYRIC_AI_MODE: 'production', PYRIC_SANDBOX: `remote:${host.url}` } });
    const line = result.output.trim().split('\n').filter((l) => l.startsWith('{')).at(-1) ?? '';
    const report = JSON.parse(line) as { token: string; seen: { host: string; appCheck: string | null }[]; mirrorLoaded: boolean; bridgeLoaded: boolean };
    assert.equal(report.token, 'attested-by-the-server');
    assert.equal(report.bridgeLoaded, true, 'the module record missed the App Check bridge, so it proves nothing');
    assert.equal(report.mirrorLoaded, false, "the server loaded Pyric's App Check mirror");
    assert.deepEqual(report.seen.map((s) => s.appCheck), ['attested-by-the-server'], line);
  });

  const firebaseToken = await app.step("sign a token shaped like Firebase's, and publish its key as Firebase's public keys", () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, use: 'sig', alg: 'RS256' };
    app.writeFile('jwks.json', JSON.stringify({ keys: [jwk] }));
    return firebaseShapedToken(privateKey);
  });

  const backendToken = await app.step('the page gets the token from Firebase to send to its backend', async () => {
    const token = await page.evaluate((issued) => tokenForBackend(issued), firebaseToken);
    assert.equal(token, firebaseToken);
    return token;
  });

  const standIn = { NODE_OPTIONS: '--import ./jwks-stand-in.mjs', JWKS_FILE: 'jwks.json' };

  await app.step("a registered server in production AI mode verifies the page's Firebase token with firebase-admin", async () => {
    const { output } = await app.serverScript('verify.mjs', [backendToken], {
      env: { PYRIC_AI_MODE: 'production', PYRIC_SANDBOX: `remote:${host.url}`, ...standIn },
      timeoutMs: 60_000,
    });
    const report = verifyReport(output);
    const [first, again, tampered, consume1, consume2, sandbox, sandboxTampered] = report.results;
    assert.deepEqual(first, verified('firebase', { jwksRequests: 1 }), 'the first verify fetches the public keys once');
    assert.deepEqual(again, verified('again'), 'a second verify uses the cached keys');
    assert.deepEqual(tampered, refused('tampered', SIGNATURE), "a tampered Firebase token gets firebase-admin's signature error");
    assert.deepEqual([consume1, consume2], [verified('consume-1', { alreadyConsumed: false }), verified('consume-2', { alreadyConsumed: true })]);
    assert.deepEqual(sandbox, verified('sandbox'), "the server's own sandbox token still verifies, with no request");
    assert.deepEqual(sandboxTampered, refused('sandbox-tampered', SIGNATURE));
    assert.deepEqual(report.served, ['firebaseappcheck.googleapis.com/v1/jwks'], 'exactly one request, for the public keys');
    assert.deepEqual(report.refused, [], `requests that tried to leave the machine: ${report.refused.join(', ')}`);
    assert.equal(report.realAdminLoaded, true, 'the real firebase-admin never loaded, so it verified nothing');
    assert.doesNotMatch(output, /the real firebase-admin loaded from/, 'the tripwire fired on the verifier bridge');
  });

  await app.step('in sandbox AI mode the same token gets an error that says why, and nothing leaves the machine', async () => {
    const { output } = await app.serverScript('verify.mjs', [backendToken], {
      env: { PYRIC_SANDBOX: `remote:${host.url}`, VERIFY_STEPS: 'sandbox-ai-mode', ...standIn },
      timeoutMs: 60_000,
    });
    const report = verifyReport(output);
    assert.deepEqual(report.results, [refused('firebase', NOT_SANDBOX)]);
    assert.deepEqual([report.served, report.refused], [[], []]);
    assert.equal(report.realAdminLoaded, false, 'sandbox AI mode loaded the real firebase-admin');
  });
});
