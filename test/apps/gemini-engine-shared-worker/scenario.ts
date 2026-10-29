// An app on the Vite plugin's default plane (the SharedWorker) selects the
// gemini engine, as #1575's report does. The dev server holds the Gemini API
// key in its environment. A page that never initialized App Check gets AI
// Logic's 403. A page that initialized it first gets Gemini's answer, with
// the key the server attached: the key never reaches the browser (#1584).
//
// A local stand-in plays the Gemini API, so no request reaches Google and no
// real key is used. The same page then runs on the in-page sandbox and on
// `hosted: true`, and gets the same results. The in-page step runs last:
// its init script forces every later page in the context in-page.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { BrowserContext } from 'playwright';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function runGemini(tag: string, withAppCheck: boolean): Promise<Record<string, unknown>>;

/** A made-up key. The stand-in accepts only this one. */
const SERVER_KEY = 'scenario-gemini-key-1584';
const ANSWER = 'Hello from the Gemini stand-in.';
const MODEL = 'gemini-2.5-flash';
const GATE_MESSAGE = 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check';

function refusal(op: string) {
  return {
    ok: false,
    code: 'fetch-error',
    status: 403,
    message: `AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/${MODEL}:${op}: [403 Forbidden] ${GATE_MESSAGE} (AI/fetch-error)`,
  };
}

const REFUSED = {
  generateContent: refusal('generateContent'),
  generateContentStream: refusal('streamGenerateContent'),
  countTokens: refusal('countTokens'),
};

const ANSWERED = {
  generateContent: { ok: true, text: ANSWER },
  generateContentStream: { ok: true, text: ANSWER },
  countTokens: { ok: true, text: '3' },
};

/** What the stand-in saw: the action and the key each request carried. */
interface Seen { action: string; key: string | null }

const RESPONSE = {
  candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 6, totalTokenCount: 9 },
  modelVersion: MODEL,
};

const INVALID_KEY = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };

function answer(action: string, response: import('node:http').ServerResponse): void {
  if (action === 'streamGenerateContent') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(RESPONSE)}\r\n\r\n`);
    return;
  }
  const body = action === 'countTokens' ? { totalTokens: 3 } : RESPONSE;
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** The Gemini REST API, as far as these three calls go. */
function geminiStandIn(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const action = url.match(new RegExp(`^/v1beta/models/${MODEL}:(\\w+)`))?.[1] ?? `unexpected ${request.method} ${url}`;
    // The engine appends `?key=` after the stream's `?alt=sse`, so read the key with a pattern.
    const key = url.match(/[?&]key=([^&]*)/)?.[1] ?? null;
    seen.push({ action, key: key === null ? null : decodeURIComponent(key) });
    request.resume();
    request.on('end', () => {
      if (key !== SERVER_KEY) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(INVALID_KEY));
        return;
      }
      answer(action, response);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, seen, server });
    });
  });
}

/** Every body the browser received, so the scenario can look for the key in them. */
function recordBodies(context: BrowserContext): string[] {
  const bodies: string[] = [];
  context.on('response', (response) => {
    void response.text().then((text) => bodies.push(`${response.url()}\n${text}`), () => {});
  });
  return bodies;
}

async function openPage(app: App, host: DevServer) {
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'runGemini' in window);
  return page;
}

async function servedText(host: DevServer, path: string): Promise<string> {
  const response = await fetch(new URL(path, host.url));
  assert.equal(response.status, 200, path);
  return response.text();
}

const answeredAt = (count: number): Seen[] =>
  Array.from({ length: count }, () => ['generateContent', 'streamGenerateContent', 'countTokens'])
    .flat()
    .map((action) => ({ action, key: SERVER_KEY }));

export default scenario(async (app) => {
  const standIn = await geminiStandIn();
  try {
    const env = { GEMINI_API_KEY: SERVER_KEY, GEMINI_STAND_IN_URL: standIn.url };
    const bodies = recordBodies(await app.browser());
    const host = await app.step('start the dev server on the default SharedWorker plane, with the key in its environment', () =>
      app.devServer({ env }));

    const page = await app.step('open the page', () => openPage(app, host));

    await app.step('SharedWorker: without App Check, AI Logic\'s 403 and nothing reaches Gemini', async () => {
      const result = await page.evaluate(() => runGemini('no-app-check', false));
      assert.deepEqual(result, REFUSED);
      assert.deepEqual(standIn.seen, []);
    });

    await app.step('SharedWorker: with App Check first, Gemini answers with the key the server attached', async () => {
      const result = await page.evaluate(() => runGemini('app-check-first', true));
      assert.deepEqual(result, ANSWERED);
      assert.deepEqual(standIn.seen, answeredAt(1));
    });

    const hostedServer = await app.step('start the dev server with hosted: true', () =>
      app.devServer({ name: 'hosted-dev-server', env: { ...env, HOSTED: '1' } }));

    await app.step('hosted: true: the same refusal and the same answer', async () => {
      const hostedPage = await openPage(app, hostedServer);
      assert.deepEqual(await hostedPage.evaluate(() => runGemini('hosted-no-app-check', false)), REFUSED);
      assert.deepEqual(await hostedPage.evaluate(() => runGemini('hosted-app-check-first', true)), ANSWERED);
      assert.deepEqual(standIn.seen, answeredAt(2));
    });

    await app.step('in-page sandbox: the same refusal and the same answer', async () => {
      const context = await app.browser();
      await context.addInitScript(() => {
        (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
      });
      const inPage = await openPage(app, host);
      assert.deepEqual(await inPage.evaluate(() => runGemini('in-page-no-app-check', false)), REFUSED);
      assert.deepEqual(await inPage.evaluate(() => runGemini('in-page-app-check-first', true)), ANSWERED);
      assert.deepEqual(standIn.seen, answeredAt(3));
    });

    await app.step('the key is in nothing the dev server serves to the browser', async () => {
      const served = await Promise.all(['/', '/main.js', '/__pyric/init.json', '/__pyric/sdk/worker.js'].map((path) => servedText(host, path)));
      for (const text of [...served, ...bodies]) assert.ok(!text.includes(SERVER_KEY), text.slice(0, 200));
      assert.ok(bodies.length > 0, 'the browser received responses');
    });
  } finally {
    standIn.server.close();
  }
});
