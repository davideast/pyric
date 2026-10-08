// With PYRIC_AI_MODE=production, the page's firebase/ai is the Firebase SDK.
// Its requests leave the browser for Google with the app's own project and
// API key and the requested model id unchanged, and an upstream error reaches
// the app. A Playwright route answers in place of Google: nothing in this
// scenario reaches a real Google endpoint.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

const API_KEY = 'AIzaSyDemoKeyForReproOnly000000000000';
const RETIRED_MODEL = 'gemini-2.5-flash';
const MODEL = 'gemini-3.5-flash-lite';

interface Outcome { ok: boolean; modelVersion?: string | null; text?: string; error?: string }
interface Captured { url: URL; apiKey: string | null; model: string }
declare function runRepro(backend: 'vertex' | 'google', model: string): Promise<Outcome>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server in production AI mode', () =>
    app.devServer({ env: { PYRIC_AI_MODE: 'production' } }));

  const captured: Captured[] = [];
  await app.step('answer Google AI endpoints from a route', async () => {
    const context = await app.browser();
    const fakeGoogle = async (route: import('@playwright/test').Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const model = url.pathname.match(/\/models\/([^/:]+):/)?.[1] ?? '';
      captured.push({ url, apiKey: request.headers()['x-goog-api-key'] ?? null, model });
      if (model === RETIRED_MODEL) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: {
            code: 404,
            message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`,
            status: 'NOT_FOUND',
          } }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP', index: 0 }],
          modelVersion: model,
        }),
      });
    };
    await context.route('https://firebasevertexai.googleapis.com/**', fakeGoogle);
    await context.route('https://generativelanguage.googleapis.com/**', fakeGoogle);
  });

  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runRepro' in window);
    return page;
  });

  await app.step('the dev server leaves firebase/ai to the Firebase SDK', async () => {
    const main = await (await fetch(`${host.url}/main.js`)).text();
    assert.doesNotMatch(main, /serve\/entries\/ai\.js/, `firebase/ai was swapped:\n${main.split('\n').slice(0, 3).join('\n')}`);
  });

  await app.step('VertexAIBackend calls Google with the app project, key, and model', async () => {
    const outcome = await page.evaluate(([model]) => runRepro('vertex', model!), [MODEL]);
    assert.equal(captured.length, 1, `requests that left the browser for Google: ${captured.map((c) => c.url.href).join(', ') || 'none'}; app saw ${JSON.stringify(outcome)}`);
    const [request] = captured;
    assert.equal(request!.url.hostname, 'firebasevertexai.googleapis.com');
    assert.match(request!.url.pathname, /\/projects\/my-real-project\/locations\/global\//);
    assert.equal(request!.model, MODEL);
    assert.equal(request!.apiKey, API_KEY);
    assert.deepEqual(outcome, { ok: true, modelVersion: MODEL, text: 'pong' });
  });

  await app.step('a retired model id goes upstream unchanged and its 404 reaches the app', async () => {
    const outcome = await page.evaluate(([model]) => runRepro('vertex', model!), [RETIRED_MODEL]);
    assert.equal(captured.at(-1)?.model, RETIRED_MODEL);
    assert.equal(outcome.ok, false, `the app got ${JSON.stringify(outcome)}`);
    assert.match(outcome.error ?? '', /404/);
  });

  await app.step('GoogleAIBackend calls Google with the app project and model', async () => {
    const before = captured.length;
    const outcome = await page.evaluate(([model]) => runRepro('google', model!), [MODEL]);
    assert.equal(captured.length, before + 1, `the app got ${JSON.stringify(outcome)}`);
    const request = captured.at(-1)!;
    assert.ok(['firebasevertexai.googleapis.com', 'generativelanguage.googleapis.com'].includes(request.url.hostname), request.url.href);
    assert.match(request.url.pathname, /\/projects\/my-real-project\/models\//);
    assert.equal(request.model, MODEL);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  await app.step('no AI request reached the dev server broker', () => {
    assert.doesNotMatch(host.process.output, /\[pyric\/ai\] engine resolved/);
  });
});
