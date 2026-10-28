// Production AI mode on the import-map plane: plain `pyric sandbox`, no Vite
// (#1290). The page's firebase/ai is the Firebase SDK, built from the app's
// own firebase install, and its firebase/app-check is the Firebase SDK
// attached to the same app, so AI Logic requests carry the App Check token.
// The same calls as ai-production-app-check, which covers the Vite and
// register planes.
//
// Nothing leaves the machine. A Playwright route answers Google the way AI
// Logic does (403 without a token, captured in app-check-ai-gate-wire) and
// aborts every other external request the page makes. The sandbox process
// runs with its HTTP proxy set to a local trap that refuses and records every
// request, and the scenario asserts the trap saw none.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { scenario } from '../driver.ts';

const DENIED = {
  error: {
    code: 403,
    message: 'Firebase AI Logic has been deactivated in this project. To resume using Firebase AI Logic, you must enforce Firebase App Check. Learn more: https://firebase.google.com/docs/ai-logic/app-check',
    status: 'PERMISSION_DENIED',
  },
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AI_LOGIC_HOST = 'firebasevertexai.googleapis.com';

interface Outcome { ok: boolean; text?: string; error?: string }
declare function runWithAppCheck(): Promise<{ token: string; outcome: Outcome }>;
declare function runAppCheckAfterAi(): Promise<Outcome>;

/** An HTTP proxy that refuses every request and CONNECT, and records each. */
function proxyTrap(): Promise<{ port: number; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(403).end('pyric scenario: no request leaves the machine');
  });
  server.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, seen, server });
    });
  });
}

export default scenario(async (app) => {
  const trap = await proxyTrap();
  try {
    const trapUrl = `http://127.0.0.1:${trap.port}`;
    const host = await app.step('start pyric sandbox in production AI mode, with outbound requests trapped', () =>
      app.sandboxServer({
        env: {
          PYRIC_AI_MODE: 'production',
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: trapUrl,
          HTTPS_PROXY: trapUrl,
          NO_PROXY: '127.0.0.1,localhost,::1',
        },
      }));

    const aiHeaders: (string | null)[] = [];
    const leaked: string[] = [];
    const pageRequests: string[] = [];
    await app.step('answer AI Logic from a route and abort every other external request', async () => {
      const context = await app.browser();
      context.on('request', (request) => pageRequests.push(request.url()));
      await context.route(() => true, (route) => {
        const url = new URL(route.request().url());
        const isLocal = LOCAL_HOSTS.has(url.hostname) || url.protocol === 'data:' || url.protocol === 'blob:';
        if (isLocal) return route.fallback();
        if (url.hostname !== AI_LOGIC_HOST) {
          leaked.push(`${route.request().method()} ${url.href}`);
          return route.abort('blockedbyclient');
        }
        const header = route.request().headers()['x-firebase-appcheck'] ?? null;
        aiHeaders.push(header);
        if (header === null) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(DENIED) });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }] }),
        });
      });
    });

    const page = await app.step('the page loads with no module error', async () => {
      const page = await app.page(host.url);
      await page.waitForFunction(() => 'runWithAppCheck' in window, undefined, { timeout: 30_000 }).catch((error: unknown) => {
        throw new Error(`main.js never ran (${String(error)}):\n${app.browserLog.join('\n')}`);
      });
      const errors = app.browserLog.filter((line) => /^\[page \d+ error\]/.test(line));
      assert.deepEqual(errors, []);
      return page;
    });

    await app.step('the import map sends firebase/ai to the Firebase SDK and firebase/app-check to the App Check bridge', async () => {
      const html = await (await fetch(`${host.url}/`)).text();
      const match = /<script type="importmap"[^>]*>([^<]*)<\/script>/.exec(html);
      assert.ok(match, `the page has no import map:\n${html}`);
      const { imports } = JSON.parse(match[1]!) as { imports: Record<string, string> };
      assert.equal(imports['firebase/ai'], '/__pyric/sdk/firebase-sdk-ai.js', JSON.stringify(imports));
      assert.equal(imports['firebase/app-check'], '/__pyric/sdk/app-ai-passthrough-app-check.js');
      assert.equal(imports['firebase/app'], '/__pyric/sdk/app-ai-passthrough.js');
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

    await app.step("the page never loads Pyric's App Check mirror or AI broker", () => {
      const mirror = pageRequests.filter((url) => /\/__pyric\/sdk\/(?:app-check|ai)\.js/.test(url));
      assert.deepEqual(mirror, [], `the page loaded Pyric's App Check mirror or AI broker: ${mirror.join(', ')}`);
      const served = pageRequests.filter((url) => /\/__pyric\/sdk\/firebase-sdk-ai\.js$/.test(url));
      assert.equal(served.length, 1, `the page did not load the Firebase SDK's firebase/ai: ${pageRequests.join('\n')}`);
    });

    await app.step('nothing left the machine', () => {
      assert.deepEqual(leaked, [], `the page reached for external hosts: ${leaked.join(', ')}`);
      assert.deepEqual(trap.seen, [], `pyric sandbox reached for external hosts: ${trap.seen.join(', ')}`);
    });
  } finally {
    trap.server.close();
  }
});
