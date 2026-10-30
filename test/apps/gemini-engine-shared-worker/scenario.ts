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
//
// The stand-in refuses one model with an error that quotes the request URL,
// key included, as a gateway can. The browser must get `key=***` instead.
// Playwright reports no SharedWorker fetches, so for that plane the scenario
// reads the worker's route itself, with the worker's request.
//
// It refuses a second model with Gemini's invalid-key message, the key quoted
// in plain text, as a gateway can (#1631). On `hosted: true` the Node host
// runs the engine itself, so the page's AIError and the terminal's
// rejection block must both read `API key ***`.
//
// Vite serves every `VITE_`-prefixed variable to any module that reads
// `import.meta.env`. The page never reads it, so no module the dev server
// serves may carry the dev server's `VITE_` value: Pyric's own modules must
// not read `import.meta.env` (#1632). A key in `VITE_GEMINI_API_KEY`, in the
// shell or in `.env`, stops the dev server with a message to rename it.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { BrowserContext } from 'playwright';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function runGemini(tag: string, withAppCheck: boolean): Promise<Record<string, unknown>>;
declare function runGeminiError(tag: string, model?: string): Promise<{ ok: boolean; status?: number; message?: string }>;

/** A made-up key. The stand-in accepts only this one. */
const SERVER_KEY = 'scenario-gemini-key-1584';
/** A made-up value for a `VITE_` variable the page never reads. */
const VITE_VALUE = 'scenario-vite-value-1632';
/** What the dev server says when the key is in `VITE_GEMINI_API_KEY`. */
const RENAME_MESSAGE = /VITE_GEMINI_API_KEY is set[\s\S]*Rename it to GEMINI_API_KEY/;
const ANSWER = 'Hello from the Gemini stand-in.';
const MODEL = 'gemini-2.5-flash';
/** The model the stand-in refuses with an error that quotes the request URL. */
const ECHO_MODEL = 'gemini-echo-url';
/** The model the stand-in refuses with Gemini's invalid-key message, quoting the key in plain text. */
const ECHO_KEY_MODEL = 'gemini-echo-key';
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
/** An error the stand-in sent that quotes the request URL. */
interface Echoed { url: string; body: string }

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

function echoMessage(url: string, key: string | null): string {
  const quotesKey = url.includes(`/models/${ECHO_KEY_MODEL}:`);
  if (quotesKey) return `API key ${key ?? ''} not valid. Please pass a valid API key.`;
  return `Request to ${url} was refused by the gateway.`;
}

function echoError(url: string, key: string | null, response: import('node:http').ServerResponse): string {
  const body = JSON.stringify({ error: { code: 400, message: echoMessage(url, key), status: 'INVALID_ARGUMENT' } });
  response.writeHead(400, { 'content-type': 'application/json' }).end(body);
  return body;
}

/** The Gemini REST API, as far as these three calls go. */
function geminiStandIn(): Promise<{ url: string; seen: Seen[]; echoed: Echoed[]; server: Server }> {
  const seen: Seen[] = [];
  const echoed: Echoed[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const isEcho = [ECHO_MODEL, ECHO_KEY_MODEL].some((model) => path.startsWith(`/v1beta/models/${model}:`));
    const action = path.match(new RegExp(`^/v1beta/models/${MODEL}:(\\w+)`))?.[1] ?? `unexpected ${request.method} ${path}`;
    const key = path.match(/[?&]key=([^&]*)/)?.[1] ?? null;
    if (!isEcho) seen.push({ action, key: key === null ? null : decodeURIComponent(key) });
    request.resume();
    request.on('end', () => {
      if (isEcho) {
        const url = `http://${request.headers.host}${path}`;
        echoed.push({ url, body: echoError(url, key === null ? null : decodeURIComponent(key), response) });
        return;
      }
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
      resolve({ url: `http://127.0.0.1:${port}`, seen, echoed, server });
    });
  });
}

/**
 * Send the request the SharedWorker sends for the echo model, from the page's
 * origin, and return what the dev server answers it.
 */
async function workerRouteAnswer(host: DevServer): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL(`/__pyric/ai-proxy/gemini/v1beta/models/${ECHO_MODEL}:generateContent`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(host.url).origin },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }] }),
  });
  return { status: response.status, text: await response.text() };
}

/** The page's refusal for the echo model: the stand-in's 400, with the key masked. */
function assertMaskedRefusal(result: { ok: boolean; status?: number; message?: string }): void {
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message ?? '', /was refused by the gateway/);
  assert.match(result.message ?? '', /key=\*\*\*/);
  assert.ok(!(result.message ?? '').includes(SERVER_KEY), result.message);
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

/** Starts Vite the way `devServer` does, and returns how it exited. */
function viteRun(app: App, port: number, env: Record<string, string>) {
  const args = ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  return app.command('node', args, { env, timeoutMs: 30_000 });
}

/** The dev server refused to start, said to rename the key, and never printed it. */
function assertRefusedViteKey(result: { code: number | null; output: string }): void {
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, RENAME_MESSAGE);
  assert.ok(!result.output.includes(SERVER_KEY), result.output);
}

/** What the dev server serves the page and the SharedWorker directly. */
const SERVED_PATHS = ['/', '/main.js', '/__pyric/init.json', '/__pyric/sdk/worker.js'];

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
    const env = { GEMINI_API_KEY: SERVER_KEY, GEMINI_STAND_IN_URL: standIn.url, VITE_SCENARIO_VALUE: VITE_VALUE };
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

    await app.step('SharedWorker: an upstream error that quotes the key reaches the browser with the key masked', async () => {
      assertMaskedRefusal(await page.evaluate(() => runGeminiError('error-quotes-url')));
      assert.equal(standIn.echoed.length, 1);
      assert.ok(standIn.echoed[0]!.body.includes(`key=${SERVER_KEY}`), 'the stand-in quoted the key');
      const answer = await workerRouteAnswer(host);
      assert.equal(answer.status, 400);
      assert.ok(!answer.text.includes(SERVER_KEY), answer.text);
      assert.match(answer.text, /key=\*\*\*/);
      assert.equal(standIn.echoed.length, 2);
    });

    const hostedServer = await app.step('start the dev server with hosted: true', () =>
      app.devServer({ name: 'hosted-dev-server', env: { ...env, HOSTED: '1' } }));

    await app.step('hosted: true: the same refusal and the same answer', async () => {
      const hostedPage = await openPage(app, hostedServer);
      assert.deepEqual(await hostedPage.evaluate(() => runGemini('hosted-no-app-check', false)), REFUSED);
      assert.deepEqual(await hostedPage.evaluate(() => runGemini('hosted-app-check-first', true)), ANSWERED);
      assert.deepEqual(standIn.seen, answeredAt(2));
    });

    await app.step('hosted: true: an upstream error that quotes the key in plain text reaches the page and the terminal masked', async () => {
      const hostedPage = await openPage(app, hostedServer);
      const since = hostedServer.process.mark();
      const result = await hostedPage.evaluate((model) => runGeminiError('hosted-error-quotes-key', model), ECHO_KEY_MODEL);
      const quoted = standIn.echoed.at(-1)!;
      assert.ok(quoted.url.includes(`/models/${ECHO_KEY_MODEL}:`), quoted.url);
      assert.ok(quoted.body.includes(`API key ${SERVER_KEY} not valid`), 'the stand-in quoted the key');
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.ok(!(result.message ?? '').includes(SERVER_KEY), result.message);
      assert.match(result.message ?? '', /API key \*\*\* not valid/);
      await hostedServer.process.waitForLog(/ai request rejected: API key \*\*\* not valid/, { since });
      assert.ok(!hostedServer.process.output.includes(SERVER_KEY), 'the hosted dev server printed the key');
    });

    await app.step('in-page sandbox: the same refusal and the same answer', async () => {
      const context = await app.browser();
      await context.addInitScript(() => {
        (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
      });
      const inPage = await openPage(app, host);
      assert.deepEqual(await inPage.evaluate(() => runGemini('in-page-no-app-check', false)), REFUSED);
      assert.deepEqual(await inPage.evaluate(() => runGemini('in-page-app-check-first', true)), ANSWERED);
      // In-page fetches are reported to the context, so the last step checks this error's body too.
      app.expectHostError(new RegExp(`^400 POST /__pyric/ai-proxy/gemini/v1beta/models/${ECHO_MODEL}:generateContent`));
      assertMaskedRefusal(await inPage.evaluate(() => runGeminiError('in-page-error-quotes-url')));
      assert.deepEqual(standIn.seen, answeredAt(3));
    });

    await app.step('the key is in nothing the dev server serves to the browser', async () => {
      const served = await Promise.all(SERVED_PATHS.map((path) => servedText(host, path)));
      for (const text of [...served, ...bodies]) assert.ok(!text.includes(SERVER_KEY), text.slice(0, 200));
      assert.ok(bodies.length > 0, 'the browser received responses');
    });

    await app.step('no module the dev server serves carries a VITE_ variable the page never reads', async () => {
      const served = await Promise.all(SERVED_PATHS.map(async (path) => `${path}\n${await servedText(host, path)}`));
      const carriers = [...served, ...bodies].filter((text) => text.includes(VITE_VALUE)).map((text) => text.split('\n', 1)[0]);
      assert.deepEqual(carriers, []);
    });

    await app.step('with the key in VITE_GEMINI_API_KEY, the dev server refuses to start and says to rename it', async () => {
      const viteEnv = { GEMINI_STAND_IN_URL: standIn.url, VITE_GEMINI_API_KEY: SERVER_KEY };
      assertRefusedViteKey(await viteRun(app, await app.freePort(), viteEnv));
    });

    await app.step('with the key in .env as VITE_GEMINI_API_KEY, the dev server refuses the same way', async () => {
      app.writeFile('.env', `VITE_GEMINI_API_KEY=${SERVER_KEY}\n`);
      assertRefusedViteKey(await viteRun(app, await app.freePort(), { GEMINI_STAND_IN_URL: standIn.url }));
    });
  } finally {
    standIn.server.close();
  }
});
