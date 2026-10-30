// In the default sandbox AI mode, firebase/app-check is Pyric's mirror: an app
// that calls initializeAppCheck on its first run gets a working handle and
// tokens shaped like production's, with no reCAPTCHA or App Check request
// leaving the browser. A server that initializes firebase-admin the usual
// way, with only `cert(serviceAccount)`, finds its project in the service
// account's project_id and verifies the page's token (#1294).
//
// From November 2, 2026 Firebase AI Logic refuses requests without an App
// Check token, and so does the sandbox (#1291), on every plane: the Node host,
// the SharedWorker, the in-page sandbox and a registered Node process. An app
// that never initialized App Check, or initialized it after getAI, gets
// production's 403; one that initialized it first answers, with or without
// the debug provider, and with limited-use tokens. Pyric's guidance prints in
// the dev server terminal and the browser console beside the error.
//
// With no debug token set, production calls an app's CustomProvider and sends
// the token it returns, and so does the sandbox (#1642): a provider backed by
// a server that mints with firebase-admin's createToken answers, and one that
// returns a token that is not an App Check token, or rejects, gets the 403.
// With limited-use tokens a rejecting provider sends no request: the call
// fails with the SDK's `Error fetching from <url>: <message>` wrapper.
//
// A server has no `document`, so the Firebase SDK's reCAPTCHA providers throw
// `ReferenceError: document is not defined` from initializeAppCheck there,
// debug token or not, and so does the sandbox (#1643): in a registered Node
// process, and in a server-rendered module that imports the app's shared
// firebase.ts. A server attests with a CustomProvider instead.
import assert from 'node:assert/strict';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function runAppCheck(): Promise<Record<string, unknown>>;
declare function runSharedAppCheck(): Promise<Record<string, unknown>>;
declare function runAiChecks(tag: string, tokenUrl: string): Promise<Record<string, unknown>>;

const NO_DOCUMENT = { name: 'ReferenceError', message: 'document is not defined' };

/**
 * What the real SDK does in plain Node (firebase 12.13.0): the first
 * initializeAppCheck throws after App Check is set up for the app, so the same
 * options return the handle and another site key is a second initialization.
 */
const RECAPTCHA_WITHOUT_DOCUMENT = { first: NO_DOCUMENT, sameOptions: 'returned', otherSiteKey: 'appCheck/already-initialized' };
const RECAPTCHA_CHECKS = {
  ReCaptchaV3Provider: { noDebug: RECAPTCHA_WITHOUT_DOCUMENT, debug: RECAPTCHA_WITHOUT_DOCUMENT },
  ReCaptchaEnterpriseProvider: { noDebug: RECAPTCHA_WITHOUT_DOCUMENT, debug: RECAPTCHA_WITHOUT_DOCUMENT },
};

function loggedJson(output: string, label: string): unknown {
  const line = output.match(new RegExp(`^${label} (.*)$`, 'm'));
  assert.ok(line, output);
  return JSON.parse(line[1]!);
}

const GATE_MESSAGE = 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check';
/**
 * Apps `runAiChecks` leaves refused: one with no App Check, one that called
 * getAI before initializeAppCheck, and the two whose CustomProvider returns an
 * invalid token or rejects.
 */
const REFUSED_APPS_PER_RUN = 4;

const HINT = /Call initializeAppCheck\(app, \{ provider \}\) before getAI\(app\)\./;

function refusal(op: string) {
  return {
    code: 'fetch-error',
    status: 403,
    message: `AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/gemini-flash-lite-latest:${op}: [403 Forbidden] ${GATE_MESSAGE} (AI/fetch-error)`,
  };
}

function expected(targetKind: string) {
  return {
    targetKind,
    noAppCheck: {
      generateContent: refusal('generateContent'),
      generateContentStream: refusal('streamGenerateContent'),
      countTokens: refusal('countTokens'),
    },
    appCheckFirst: { generateContent: 'answered', generateContentStream: 'answered', countTokens: 'answered' },
    getAiFirst: refusal('generateContent'),
    debugProvider: 'answered',
    limitedUse: 'answered',
    customProvider: {
      valid: { providerCalled: true, result: 'answered' },
      invalidToken: { providerCalled: true, result: refusal('generateContent') },
      rejects: { providerCalled: true, result: refusal('generateContent') },
      limitedUseRejects: {
        providerCalled: true,
        result: {
          code: 'error',
          status: null,
          message: 'AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/gemini-flash-lite-latest:generateContent: attestation failed (AI/error)',
        },
      },
    },
  };
}

/** GET /ssr/app-check: the module importing the shared firebase.ts, and the one with a CustomProvider. */
async function assertSsrAppCheck(server: DevServer, tokenUrl: string): Promise<void> {
  const response = await fetch(`${server.url}/ssr/app-check?token=${encodeURIComponent(tokenUrl)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sharedFirebase: { ok: false, ...NO_DOCUMENT },
    customProvider: { ok: true, value: { providerCalls: 1, sameToken: true } },
  });
}

async function openPage(app: App, host: DevServer) {
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'runAiChecks' in window);
  return page;
}

function consoleHints(app: App): number {
  return app.browserLog.filter((line) => line.includes('console.warn') && HINT.test(line)).length;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const external: string[] = [];
  await app.step('record any request to reCAPTCHA or App Check', async () => {
    const context = await app.browser();
    for (const pattern of ['https://www.google.com/recaptcha/**', 'https://www.gstatic.com/**', 'https://firebaseappcheck.googleapis.com/**']) {
      await context.route(pattern, (route) => {
        external.push(route.request().url());
        return route.abort();
      });
    }
  });

  const tokenUrl = await app.step('start the server a CustomProvider gets its token from', async () => {
    const port = await app.freePort();
    const server = app.serverProcess('token-server.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}`, TOKEN_PORT: String(port) } });
    await server.waitForLog(/token-server listening/);
    return `http://127.0.0.1:${port}/app-check-token`;
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runAppCheck' in window);
    return page;
  });

  await app.step('initializeAppCheck, getToken, getLimitedUseToken, and onTokenChanged work', async () => {
    const result = await page.evaluate(() => runAppCheck());
    assert.deepEqual(result, {
      segments: 3,
      cached: true,
      limitedDiffers: true,
      sub: '1:123456789012:web:abcdef0123456789',
      aud: ['projects/123456789012', 'projects/my-real-project'],
      iss: 'https://firebaseappcheck.googleapis.com/123456789012',
      ttl: 3600,
      listenerSawFirst: true,
      twice: 'appCheck/already-initialized',
    });
  });

  await app.step('Node host: AI Logic without App Check gets production\'s 403, with App Check it answers', async () => {
    const since = host.process.mark();
    const result = await page.evaluate((url) => runAiChecks('node-host', url), tokenUrl);
    assert.deepEqual(result, expected('transport'));
    await host.process.waitForLog(HINT, { since });
  });

  await app.step('the page console carries pyric\'s guidance once per refused app', () => {
    // runAiChecks refuses four apps (see REFUSED_APPS_PER_RUN).
    assert.equal(consoleHints(app), REFUSED_APPS_PER_RUN, app.browserLog.join('\n'));
  });

  await app.step('the page\'s shared firebase.ts initializes App Check with reCAPTCHA', async () => {
    assert.deepEqual(await page.evaluate(() => runSharedAppCheck()), { tokenSegments: 3 });
  });

  const node = await app.step('a registered Node process runs the App Check and AI Logic checks', async () => {
    // PYRIC_SANDBOX=local: the process runs its own sandbox, in process.
    const { output } = await app.serverScript('ai-server.mjs', [tokenUrl], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    return output;
  });

  await app.step('a registered Node process: initializeAppCheck with reCAPTCHA throws document is not defined', () => {
    assert.deepEqual(loggedJson(node, 'recaptcha-checks'), RECAPTCHA_CHECKS);
  });

  await app.step('a registered Node process with a CustomProvider gets the same refusal and the same answers', () => {
    assert.deepEqual(loggedJson(node, 'ai-checks'), expected('sandbox'));
    assert.match(node, HINT);
  });

  await app.step('a server-rendered module: the shared firebase.ts throws document is not defined, a CustomProvider works', () =>
    assertSsrAppCheck(host, tokenUrl));

  const workerHost = await app.step('start a SharedWorker dev server', () =>
    app.devServer({ name: 'shared-worker-dev-server', env: { SANDBOX_APP_CHECK_PLANE: 'shared-worker' } }));

  await app.step('SharedWorker dev server, server-rendered module: the same throw, and a CustomProvider works', () =>
    assertSsrAppCheck(workerHost, tokenUrl));

  await app.step('SharedWorker: the same refusal and the same answers', async () => {
    const workerPage = await openPage(app, workerHost);
    const since = workerHost.process.mark();
    const result = await workerPage.evaluate((url) => runAiChecks('shared-worker', url), tokenUrl);
    assert.deepEqual(result, expected('transport'));
    await workerHost.process.waitForLog(HINT, { since });
  });

  await app.step('in-page sandbox: the same refusal and the same answers', async () => {
    const context = await app.browser();
    await context.addInitScript(() => {
      (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
    });
    const inPage = await openPage(app, workerHost);
    const hintsBefore = consoleHints(app);
    const result = await inPage.evaluate((url) => runAiChecks('in-page', url), tokenUrl);
    assert.deepEqual(result, expected('sandbox'));
    // The terminal already printed this refusal for the SharedWorker page, and
    // the dev server throttles a repeat, so the page console is the evidence here.
    assert.equal(consoleHints(app) - hintsBefore, REFUSED_APPS_PER_RUN, app.browserLog.join('\n'));
  });

  await app.step('no request left the browser for reCAPTCHA or App Check', () => {
    assert.deepEqual(external, []);
  });

  await app.step('a server initialized with only cert(serviceAccount) verifies the page token', async () => {
    const token = await page.evaluate(() => (window as unknown as { appCheckToken: string }).appCheckToken);
    const { output } = await app.serverScript('admin-server.mjs', [token], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
      timeoutMs: 30_000,
    });
    const line = output.match(/^verify (.*)$/m);
    assert.ok(line, `no verify line in:\n${output}`);
    assert.deepEqual(JSON.parse(line[1]), {
      ok: true,
      appId: '1:123456789012:web:abcdef0123456789',
      aud: ['projects/123456789012', 'projects/my-real-project'],
      options: {},
    });
  });
});
