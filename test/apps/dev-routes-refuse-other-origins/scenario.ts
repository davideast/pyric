// The dev server's denial relay and AI proxy answer only the pages it serves.
// The app's own page still prints its rules denial in the terminal and still
// reaches the AI upstream through the proxy. A page on another localhost port
// cannot print to the terminal or spend the upstream, and an oversized body is
// refused before it is buffered, with the connection closed so the next request
// is read as a request. The AI upstream is a local stub.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { scenario } from '../driver.ts';

const ESC = '\u001b';

interface UpstreamHit { path: string; bytes: number }

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server: Server): Promise<void> {
  // The browser keeps connections alive, which would hold close() open.
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** An OpenAI-compatible upstream that answers every chat completion with "pong". */
function stubUpstream(hits: UpstreamHit[]): Server {
  return createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; });
    req.on('end', () => {
      hits.push({ path: req.url ?? '', bytes });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 0,
        model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      }));
    });
  });
}

/** A page on another localhost port, standing in for any site the developer visits. */
function otherSite(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>another site</title>');
  });
}

declare function readDenied(): Promise<string>;
declare function askModel(): Promise<{ ok: boolean; text?: string; error?: string }>;

export default scenario(async (app) => {
  const hits: UpstreamHit[] = [];
  const upstream = stubUpstream(hits);
  const other = otherSite();
  const upstreamPort = await app.freePort();
  const otherPort = await app.freePort();
  await listen(upstream, upstreamPort);
  await listen(other, otherPort);
  try {
    const host = await app.step('start the dev server with an AI model behind the proxy', () =>
      app.devServer({ env: {
        PYRIC_AI_MODEL: 'stub-model',
        PYRIC_AI_PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1`,
      } }));

    const page = await app.step('open the app page', async () => {
      const page = await app.page(host.url);
      await page.waitForFunction(() => 'readDenied' in window && 'askModel' in window);
      return page;
    });

    await app.step("the app's rules denial prints in the terminal", async () => {
      const since = host.process.mark();
      assert.equal(await page.evaluate(() => readDenied()), 'permission-denied');
      await host.process.waitForLog(/\[pyric\] denied: .*\n\s+get .*denied-by-rules\/doc-1/, { since });
    });

    await app.step("the app's AI request reaches the upstream through the proxy", async () => {
      const outcome = await page.evaluate(() => askModel());
      assert.deepEqual(outcome, { ok: true, text: 'pong' }, `upstream hits: ${JSON.stringify(hits)}`);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.path, '/v1/chat/completions');
    });

    await app.step('a denial the app page relays prints without terminal escapes', async () => {
      const since = host.process.mark();
      const status = await page.evaluate((esc) => fetch('/__pyric/denials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'read',
          message: `escaped${esc}]0;retitled\u0007\nFORGED line`,
          denialContext: { request: { method: 'get', path: 'escaped/doc' } },
        }),
      }).then((res) => res.status), ESC);
      assert.equal(status, 204);
      await host.process.waitForLog(/\[pyric\] denied: escaped/, { since });
      const printed = host.process.output.slice(since);
      assert.ok(!printed.includes(`${ESC}]0;`), `the terminal received an escape sequence:\n${JSON.stringify(printed)}`);
      assert.doesNotMatch(printed, /^FORGED line/m);
    });

    app.expectHostError(/^403 POST \/__pyric\/(denials|ai-proxy\/chat\/completions)$/);
    await app.step('a page on another port cannot print to the terminal or spend the upstream', async () => {
      const since = host.process.mark();
      const hitsBefore = hits.length;
      const attacker = await app.page(`http://localhost:${otherPort}/`);
      const statuses = await attacker.evaluate(async (target) => {
        const post = (path: string, body: string) => fetch(`${target}${path}`, {
          method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body,
        }).then(() => 'sent', (error) => `threw ${String(error)}`);
        return [
          await post('/__pyric/denials', JSON.stringify({ message: 'printed by another site', denialContext: { request: { method: 'get', path: 'x' } } })),
          await post('/__pyric/ai-proxy/chat/completions', JSON.stringify({ model: 'stub-model', messages: [] })),
        ];
      }, host.url);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.deepEqual(statuses, ['sent', 'sent']);
      assert.doesNotMatch(host.process.output.slice(since), /printed by another site/);
      assert.equal(hits.length, hitsBefore, `the proxy forwarded another site's request: ${JSON.stringify(hits.slice(hitsBefore))}`);
      await attacker.close();
    });

    await app.step('an oversized body is refused before it is buffered', async () => {
      const hitsBefore = hits.length;
      const denial = await fetch(`${host.url}/__pyric/denials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(1024 * 1024) }),
      });
      assert.equal(denial.status, 413);
      const proxied = await fetch(`${host.url}/__pyric/ai-proxy/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array(16 * 1024 * 1024),
      });
      assert.equal(proxied.status, 413);
      assert.equal(hits.length, hitsBefore);
    });

    // Each route answers 413 before it has read the upload, so each closes the
    // connection. Without that, the client sends its next request on the same
    // socket and the server reads it as the rest of the upload, answering 400
    // (#1706, #1710). Each request here is the next one for the request before it.
    await app.step('every dev route that refuses an oversized body closes the connection', async () => {
      const init = await (await fetch(`${host.url}/__pyric/init.json`)).json() as { sessionToken: string; activityToken: string };
      const padding = 'x'.repeat(1024 * 1024);
      const json = { 'content-type': 'application/json' };
      const session = { ...json, 'x-pyric-session-token': init.sessionToken };
      const refusals: Array<[string, RequestInit]> = [
        ['/__pyric/diagnostics', { method: 'POST', headers: json, body: JSON.stringify({ padding }) }],
        ['/__pyric/activity', { method: 'POST', headers: { ...json, origin: host.url, 'x-pyric-activity-token': init.activityToken }, body: JSON.stringify({ padding }) }],
        ['/__pyric/thresholds', { method: 'PUT', headers: session, body: JSON.stringify({ config: {}, padding }) }],
        ['/__pyric/indexes', { method: 'POST', headers: session, body: JSON.stringify({ query: {}, padding }) }],
      ];
      for (const [path, request] of refusals) {
        const refused = await fetch(`${host.url}${path}`, request);
        assert.equal(refused.status, 413, `${path}: ${await refused.text()}`);
        assert.equal(refused.headers.get('connection'), 'close', path);
      }
      const after = await fetch(`${host.url}/__pyric/init.json`);
      assert.equal(after.status, 200);
    });
  } finally {
    await close(upstream);
    await close(other);
  }
});
