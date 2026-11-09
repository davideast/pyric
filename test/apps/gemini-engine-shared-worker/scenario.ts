// An app on the Vite plugin's default plane (the SharedWorker) selects the
// gemini engine, as #1575's report does. The dev server holds the Gemini API
// key in its environment. A page that never initialized App Check gets AI
// Logic's 401. A page that initialized it first gets Gemini's answer, with
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
// A third model answers a 200 stream that carries an error event
// mid-response, quoting the key in plain text (#1660). On every plane the
// page must see that event with `***` in place of the key: the dev server's
// gemini proxy masks it for the SharedWorker and in-page engines, and the
// engine masks it on `hosted: true`. The SharedWorker refuses the plain-text
// key through the proxy too, not only a key quoted in the URL.
//
// A dev server with no key in its environment takes an ADC token from a
// stand-in `gcloud` on its PATH. The token has a second line, so Node's fetch
// refuses the `Authorization` header before it sends anything, and its error
// quotes the header, token included (#1737). The page's error and the dev
// server's terminal must both read `***` in place of the token.
//
// A base URL with userinfo, `http://user:password@host`, is refused by Node's
// fetch, and its error quotes the whole URL (#1766). On the SharedWorker and
// on `hosted: true`, the page's error, the gemini proxy's 502 and the dev
// server's terminal must name the host without the userinfo.
//
// Vite serves every `VITE_`-prefixed variable to any module that reads
// `import.meta.env`. The page never reads it, so no module the dev server
// serves may carry the dev server's `VITE_` value: Pyric's own modules must
// not read `import.meta.env` (#1632). A key in `VITE_GEMINI_API_KEY`, in the
// shell or in `.env`, stops the dev server with a message to rename it.
// The refusal follows the app's `envPrefix` (#1659): with `envPrefix: 'APP_'`
// Vite never serves `VITE_GEMINI_API_KEY`, so the dev server starts, and an
// `envPrefix` that covers `GEMINI_` refuses a key in `GEMINI_API_KEY`.
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function runGemini(tag: string, withAppCheck: boolean): Promise<Record<string, unknown>>;
declare function runGeminiError(tag: string, model?: string): Promise<{ ok: boolean; status?: number; message?: string }>;
declare function runGeminiStreamError(tag: string): Promise<StreamErrorResult>;

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
/** The model the stand-in answers with a 200 stream that carries an error event quoting the key. */
const STREAM_ERROR_MODEL = 'gemini-stream-error';
/** A made-up ADC token. Its second line makes it an invalid header value. */
const ADC_TOKEN = 'scenario-adc-token-1737';
/** An enforced project's refusal (capture `app-check-ai-gate-wire`, #1300). */
const GATE_MESSAGE = 'Firebase App Check token is invalid.';

/** The SDK's request URL adds `alt=sse` to a stream (#1640). */
function refusal(op: string) {
  const query = op === 'streamGenerateContent' ? '?alt=sse' : '';
  return {
    ok: false,
    code: 'fetch-error',
    status: 401,
    message: `AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/${MODEL}:${op}${query}: [401 Unauthorized] ${GATE_MESSAGE} (AI/fetch-error)`,
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

/** One answer event, then an error event that quotes the key in plain text. */
function streamWithError(key: string | null, response: import('node:http').ServerResponse): void {
  const error = { error: { code: 500, message: `Quota check failed for API key ${key ?? ''}.`, status: 'INTERNAL' } };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify(RESPONSE)}\r\n\r\ndata: ${JSON.stringify(error)}\r\n\r\n`);
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
function geminiStandIn(): Promise<{ url: string; seen: Seen[]; echoed: Echoed[]; streamed: Array<string | null>; server: Server }> {
  const seen: Seen[] = [];
  const streamed: Array<string | null> = [];
  const echoed: Echoed[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const isEcho = [ECHO_MODEL, ECHO_KEY_MODEL].some((model) => path.startsWith(`/v1beta/models/${model}:`));
    const isStreamError = path.startsWith(`/v1beta/models/${STREAM_ERROR_MODEL}:streamGenerateContent`);
    const action = path.match(new RegExp(`^/v1beta/models/${MODEL}:(\\w+)`))?.[1] ?? `unexpected ${request.method} ${path}`;
    const key = path.match(/[?&]key=([^&]*)/)?.[1] ?? null;
    if (!isEcho && !isStreamError) seen.push({ action, key: key === null ? null : decodeURIComponent(key) });
    request.resume();
    request.on('end', () => {
      if (isStreamError) {
        streamed.push(key === null ? null : decodeURIComponent(key));
        streamWithError(key === null ? null : decodeURIComponent(key), response);
        return;
      }
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
      resolve({ url: `http://127.0.0.1:${port}`, seen, echoed, streamed, server });
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

interface StreamErrorResult { chunks: string[]; settled: { ok: boolean; text?: string; message?: string } }

/**
 * The page iterated the stream's error event with the key masked, and the
 * stand-in sent that event with the key the server attached.
 */
function assertMaskedStreamError(result: StreamErrorResult, streamed: Array<string | null>): void {
  assert.equal(streamed.at(-1), SERVER_KEY, 'the stand-in streamed an error quoting the key');
  const seen = JSON.stringify(result);
  assert.ok(!seen.includes(SERVER_KEY), seen);
  assert.match(seen, /Quota check failed for API key \*\*\*\./);
}

/** Every body the browser received, so the scenario can look for the key in them. */
function recordBodies(context: BrowserContext): string[] {
  const bodies: string[] = [];
  context.on('response', (response) => {
    void response.text().then((text) => bodies.push(`${response.url()}\n${text}`), () => {});
  });
  return bodies;
}

/** A `gcloud` that prints a two-line access token, as a stand-in for ADC. */
function writeStandInGcloud(app: App): string {
  app.writeFile('gcloud', `#!/bin/sh\nprintf '${ADC_TOKEN}\\nsecond-line\\n'\n`);
  chmodSync(join(app.dir, 'gcloud'), 0o755);
  return `${app.dir}:${process.env.PATH ?? ''}`;
}

/** The page's error and the terminal quote the fetch error with the token masked. */
async function assertMaskedFetchError(result: { ok: boolean; message?: string }, server: DevServer, since: number): Promise<void> {
  assert.equal(result.ok, false);
  assert.ok(!(result.message ?? '').includes(ADC_TOKEN), result.message);
  assert.match(result.message ?? '', /Failed to connect to Gemini API at .*"Bearer \*\*\*" is an invalid header value/);
  await server.process.waitForLog(/upstream unreachable: .*"Bearer \*\*\*" is an invalid header value/, { since });
  assert.ok(!server.process.output.includes(ADC_TOKEN), 'the dev server printed the token');
}

/**
 * Userinfo the scenario puts in the stand-in's base URL (#1766). The password
 * holds a space and both quotes, which a pattern over the text stops at.
 */
const USERINFO = `gateway-user:gateway-secret-1766 "q'`;

/** The stand-in's base URL with USERINFO in it. */
function withUserinfo(url: string): string {
  return url.replace('http://', `http://${USERINFO}@`);
}

/** No surface quotes the userinfo, and the page's error still names the host. */
function assertNoUserinfo(texts: string[], host: string): void {
  for (const text of texts) {
    assert.ok(!text.includes('gateway-secret-1766'), text.slice(0, 400));
    assert.ok(!text.includes('gateway-user'), text.slice(0, 400));
  }
  assert.ok(texts[0]!.includes(`http://${host}/v1beta/models/`), texts[0]);
}

/** A dev server whose gemini base URL carries userinfo: served assets, the page, the proxy's 502 and the terminal drop it. */
async function assertUserinfoDropped(app: App, standInUrl: string, name: string, hosted: boolean): Promise<void> {
  const env = { GEMINI_API_KEY: SERVER_KEY, GEMINI_STAND_IN_URL: withUserinfo(standInUrl), ...(hosted ? { HOSTED: '1' } : {}) };
  const server = await app.devServer({ name, env });
  const page = await openPage(app, server);
  const since = server.process.mark();
  const result = await page.evaluate((tag) => runGeminiError(tag, 'gemini-2.5-flash'), name);
  assert.equal(result.ok, false);
  const texts = [result.message ?? ''];
  if (hosted) {
    await server.process.waitForLog(/ai request rejected: /, { since });
  } else {
    await server.process.waitForLog(/upstream unreachable: /, { since });
    const answer = await workerRouteAnswer(server);
    assert.equal(answer.status, 502, answer.text);
    texts.push(answer.text);
  }
  const paths = hosted ? ['/', '/main.js', '/__pyric/init.json'] : SERVED_PATHS;
  const served = await Promise.all(paths.map((path) => servedText(server, path)));
  assertNoUserinfo([...texts, ...served, server.process.output], new URL(standInUrl).host);
}

async function openPage(app: App, host: DevServer) {
  const page = await app.page(host.url);
  await page.waitForFunction(() => 'runGemini' in window);
  return page;
}

/** Starts Vite the way `devServer` does, and returns how it exited. */
function viteRun(app: App, port: number, env: Record<string, string>, configFile?: string) {
  const args = ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  if (configFile !== undefined) args.push('--config', configFile);
  return app.command('node', args, { env, timeoutMs: 30_000 });
}

/** The app's vite.config.js with the `envPrefix` named by SCENARIO_ENV_PREFIX (comma-separated). */
const ENV_PREFIX_CONFIG = 'env-prefix.config.js';
/** Starts a dev server from ENV_PREFIX_CONFIG through Vite's API, prints `listening`, and closes it. */
const START_AND_CLOSE = 'start-and-close.mjs';

function writeEnvPrefixApp(app: App): void {
  app.writeFile(ENV_PREFIX_CONFIG, [
    'import base from "./vite.config.js";',
    'export default { ...base, envPrefix: process.env.SCENARIO_ENV_PREFIX.split(",") };',
    '',
  ].join('\n'));
  app.writeFile(START_AND_CLOSE, [
    'import { createServer } from "vite";',
    `const server = await createServer({ configFile: "${ENV_PREFIX_CONFIG}", server: { host: "127.0.0.1", port: 0 } });`,
    'await server.listen();',
    'console.log("listening");',
    'await server.close();',
    'process.exit(0);',
    '',
  ].join('\n'));
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

    await app.step('SharedWorker: without App Check, AI Logic\'s 401 and nothing reaches Gemini', async () => {
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

    await app.step('SharedWorker: an upstream error that quotes the key in plain text reaches the browser masked', async () => {
      const result = await page.evaluate((model) => runGeminiError('error-quotes-key', model), ECHO_KEY_MODEL);
      assert.ok(standIn.echoed.at(-1)!.body.includes(`API key ${SERVER_KEY} not valid`), 'the stand-in quoted the key');
      assert.equal(result.status, 400);
      assert.ok(!(result.message ?? '').includes(SERVER_KEY), result.message);
      assert.match(result.message ?? '', /API key \*\*\* not valid/);
    });

    await app.step('SharedWorker: an error event mid-stream reaches the browser with the key masked', async () => {
      assertMaskedStreamError(await page.evaluate(() => runGeminiStreamError('stream-error')), standIn.streamed);
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

    await app.step('hosted: true: an error event mid-stream reaches the page with the key masked', async () => {
      const hostedPage = await openPage(app, hostedServer);
      assertMaskedStreamError(await hostedPage.evaluate(() => runGeminiStreamError('hosted-stream-error')), standIn.streamed);
    });

    await app.step('SharedWorker, ADC: a fetch error that quotes the token reaches the page and the terminal masked', async () => {
      const adcEnv = { GEMINI_STAND_IN_URL: standIn.url, PATH: writeStandInGcloud(app) };
      const adcServer = await app.devServer({ name: 'adc-dev-server', env: adcEnv });
      const adcPage = await openPage(app, adcServer);
      const since = adcServer.process.mark();
      await assertMaskedFetchError(await adcPage.evaluate(() => runGeminiError('adc-fetch-error', 'gemini-2.5-flash')), adcServer, since);
      assert.deepEqual(standIn.seen, answeredAt(2), 'nothing reached the stand-in');
    });

    await app.step('SharedWorker: a base URL with userinfo reaches the page, the 502 and the terminal without it', async () => {
      await assertUserinfoDropped(app, standIn.url, 'userinfo-dev-server', false);
      assert.deepEqual(standIn.seen, answeredAt(2), 'nothing reached the stand-in');
    });

    await app.step('hosted: true: a base URL with userinfo reaches the page and the terminal without it', async () => {
      // One hosted sandbox owns a project's hosted state at a time.
      await hostedServer.process.stop();
      await assertUserinfoDropped(app, standIn.url, 'hosted-userinfo-dev-server', true);
      assert.deepEqual(standIn.seen, answeredAt(2), 'nothing reached the stand-in');
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
      assertMaskedStreamError(await inPage.evaluate(() => runGeminiStreamError('in-page-stream-error')), standIn.streamed);
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

    await app.step('with envPrefix APP_, the dev server starts with VITE_GEMINI_API_KEY set, because Vite never serves it', async () => {
      writeEnvPrefixApp(app);
      const viteEnv = { GEMINI_STAND_IN_URL: standIn.url, VITE_GEMINI_API_KEY: SERVER_KEY, SCENARIO_ENV_PREFIX: 'APP_' };
      const result = await app.command('node', [START_AND_CLOSE], { env: viteEnv, timeoutMs: 30_000 });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /^listening$/m);
    });

    await app.step('with an envPrefix that covers GEMINI_, the dev server refuses a key in GEMINI_API_KEY', async () => {
      const viteEnv = { GEMINI_STAND_IN_URL: standIn.url, GEMINI_API_KEY: SERVER_KEY, SCENARIO_ENV_PREFIX: 'VITE_,GEMINI_' };
      const result = await viteRun(app, await app.freePort(), viteEnv, ENV_PREFIX_CONFIG);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /GEMINI_API_KEY is set\. Vite serves every variable whose name starts with GEMINI_ to the browser/);
      assert.match(result.output, /Remove GEMINI_ from envPrefix/);
      assert.ok(!result.output.includes(SERVER_KEY), result.output);
    });

    await app.step('with the key in .env as VITE_GEMINI_API_KEY, the dev server refuses the same way', async () => {
      app.writeFile('.env', `VITE_GEMINI_API_KEY=${SERVER_KEY}\n`);
      assertRefusedViteKey(await viteRun(app, await app.freePort(), { GEMINI_STAND_IN_URL: standIn.url }));
    });

    // `pyric sandbox` serves no `import.meta.env` and does not read the
    // variable either, so its banner names it as ignored (#1659).
    await app.step('pyric sandbox with only VITE_GEMINI_API_KEY set: the banner names it as ignored and says to rename it', async () => {
      app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: '.' } })}\n`);
      const sandbox = await app.sandboxServer({ env: { VITE_GEMINI_API_KEY: SERVER_KEY } });
      await sandbox.process.waitForLog(/ai {7}.*VITE_GEMINI_API_KEY is set and ignored, because Vite serves VITE_ variables to the browser by default; rename it to GEMINI_API_KEY/);
      assert.ok(!sandbox.process.output.includes(SERVER_KEY), 'the banner never prints the key');
    });
  } finally {
    standIn.server.close();
  }
});
