// In production AI mode the page's firebase/app-check is the Firebase SDK,
// attached to the same app firebase/ai reads, so AI Logic requests carry the
// App Check token. A Playwright route answers Google the way AI Logic does
// (403 without a token, captured in app-check-ai-gate-wire): nothing in this
// scenario reaches a real Google endpoint.
import assert from 'node:assert/strict';
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
});
