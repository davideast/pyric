// The create-pyric chat template's AI Logic requests carry an App Check token
// (#1299). The scenario scaffolds the template through the packed
// create-pyric, installs it, and runs its dev server in production AI mode, so
// the page's firebase/ai and firebase/app-check are the Firebase SDK. Playwright
// routes answer Google the way it answers from November 2, 2026: AI Logic
// refuses a request with no X-Firebase-AppCheck header with the captured 403
// (app-check-ai-gate-wire, noHeader), and the App Check debug exchange answers
// with the captured success shape (app-check-exchange-debug-token-wire,
// registered). Nothing reaches a real Google endpoint.
//
// On main the template initialized App Check through a dynamic import that
// resolved after getAI had run, so the chat's request went out with no header
// and AI Logic refused it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../driver.ts';
import { scaffoldChatTemplate, sendDirectPrompt, startChatDevServer, streamedReply } from '../chat-template.ts';

const OBSERVATIONS = join(import.meta.dirname, '..', '..', '..', 'packages', 'conformance', 'observations', 'app-check');
const REPLY = 'App Check reached the chat template.';

interface GateCapture { behavior: { noHeader: { httpStatus: number; raw: unknown } } }
interface ExchangeCapture { behavior: { registered: { httpStatus: number; ttl: string } } }

function capture<T>(name: string): T {
  return JSON.parse(readFileSync(join(OBSERVATIONS, `${name}.json`), 'utf8')) as T;
}

/** A token in the shape the exchange returns: three base64url segments. */
function debugExchangeToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [part({ alg: 'RS256', kid: 'scenario', typ: 'JWT' }), part({ sub: 'chat-template', provider: 'debug' }), 'c2lnbmF0dXJl'].join('.');
}

export default scenario(async (app) => {
  const gate = capture<GateCapture>('app-check-ai-gate-wire').behavior.noHeader;
  const exchange = capture<ExchangeCapture>('app-check-exchange-debug-token-wire').behavior.registered;
  const token = debugExchangeToken();

  await scaffoldChatTemplate(app);

  const host = await app.step('start the scaffolded dev server in production AI mode', () =>
    startChatDevServer(app, { PYRIC_AI_MODE: 'production' }));

  const aiHeaders: (string | null)[] = [];
  const exchanges: string[] = [];
  await app.step('answer Google from routes, as AI Logic and App Check do', async () => {
    const context = await app.browser();
    await context.route('https://firebasevertexai.googleapis.com/**', (route) => {
      const header = route.request().headers()['x-firebase-appcheck'] ?? null;
      aiHeaders.push(header);
      if (header === null) {
        return route.fulfill({ status: gate.httpStatus, contentType: 'application/json', body: JSON.stringify(gate.raw) });
      }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: streamedReply(REPLY) });
    });
    // The web SDK exchanges on content-firebaseappcheck.googleapis.com.
    await context.route(/^https:\/\/(content-)?firebaseappcheck\.googleapis\.com\//, (route) => {
      exchanges.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: exchange.httpStatus, contentType: 'application/json', body: JSON.stringify({ token, ttl: exchange.ttl }) });
    });
  });

  await app.step('a prompt sent through the chat UI gets its reply', async () => {
    try {
      await sendDirectPrompt(app, host.url, 'Say hello', REPLY);
    } catch (error) {
      throw new Error(`${String(error)}\nX-Firebase-AppCheck values AI Logic saw: ${JSON.stringify(aiHeaders)}`);
    }
  });

  await app.step('the AI Logic request carried the exchanged App Check token', () => {
    assert.ok(aiHeaders.length > 0, 'the chat sent no AI Logic request');
    assert.deepEqual(aiHeaders.filter((header) => header !== token), [], `X-Firebase-AppCheck values AI Logic saw: ${JSON.stringify(aiHeaders)}`);
    assert.ok(exchanges.every((path) => path.endsWith(':exchangeDebugToken')), `App Check calls: ${exchanges.join(', ')}`);
    assert.ok(exchanges.length > 0, 'the debug provider never exchanged a token');
  });
});
