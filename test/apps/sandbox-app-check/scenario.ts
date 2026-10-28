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
import assert from 'node:assert/strict';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function runAppCheck(): Promise<Record<string, unknown>>;
declare function runAiChecks(tag: string): Promise<Record<string, unknown>>;

const GATE_MESSAGE = 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check';
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
  };
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
    const result = await page.evaluate(() => runAiChecks('node-host'));
    assert.deepEqual(result, expected('transport'));
    await host.process.waitForLog(HINT, { since });
  });

  await app.step('the page console carries pyric\'s guidance once per refused app', () => {
    assert.ok(consoleHints(app) >= 1, app.browserLog.join('\n'));
  });

  await app.step('a registered Node process gets the same refusal and the same answers', async () => {
    // PYRIC_SANDBOX=local: the process runs its own sandbox, in process.
    const { output } = await app.serverScript('ai-server.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    const line = output.match(/^ai-checks (.*)$/m);
    assert.ok(line, output);
    assert.deepEqual(JSON.parse(line[1]!), expected('sandbox'));
    assert.match(output, HINT);
  });

  const workerHost = await app.step('start a SharedWorker dev server', () =>
    app.devServer({ name: 'shared-worker-dev-server', env: { SANDBOX_APP_CHECK_PLANE: 'shared-worker' } }));

  await app.step('SharedWorker: the same refusal and the same answers', async () => {
    const workerPage = await openPage(app, workerHost);
    const since = workerHost.process.mark();
    const result = await workerPage.evaluate(() => runAiChecks('shared-worker'));
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
    const result = await inPage.evaluate(() => runAiChecks('in-page'));
    assert.deepEqual(result, expected('sandbox'));
    // The terminal already printed this refusal for the SharedWorker page, and
    // the dev server throttles a repeat, so the page console is the evidence here.
    assert.ok(consoleHints(app) > hintsBefore, app.browserLog.join('\n'));
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
