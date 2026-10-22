/**
 * Child-process fixture for `ai#app-check-attestation-failure`: the Firebase
 * App Check SDK in debug mode (a module-wide setting, hence its own process)
 * through the served App Check bridge, with an unregistered debug token. `fetch`
 * answers the debug exchange and AI Logic with the captured 403 envelopes
 * (`app-check-exchange-debug-token-wire`, `app-check-ai-gate-wire`), so nothing
 * reaches Google. Prints one JSON line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OBS = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'app-check');
const behavior = (name: string) => (JSON.parse(readFileSync(join(OBS, `${name}.json`), 'utf8')) as { behavior: Record<string, any> }).behavior;
const exchangeDenied = behavior('app-check-exchange-debug-token-wire').unregistered.body;
const aiDenied = behavior('app-check-ai-gate-wire').noHeader.raw;
const OPTIONS = { apiKey: 'demo-api-key', appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4', projectId: 'genkit-idx' };
const MODEL = 'gemini-flash-lite-latest';

(globalThis as { self?: unknown }).self ??= globalThis;
(globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = '00000000-0000-4000-8000-000000000000';

const aiRequests: (string | null)[] = [];
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const href = String(url);
  // The capture's response line read `403 Forbidden`; the SDK puts the status text in its message.
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } });
  if (href.includes('firebaseappcheck.googleapis.com')) return json(exchangeDenied, 403);
  aiRequests.push(new Headers(init?.headers).get('x-firebase-appcheck'));
  return json(aiDenied, 403);
}) as typeof fetch;

const { shadowedAppRegistry } = await import('../../../src/register/app-bridge-shadow.js');
const bridge = await import('../../../src/register/app-bridge-app-check.js');
const sdk = await import('firebase/app-check');
const ai = await import('firebase/ai');

const apps = new Map<string, object>();
const registry = shadowedAppRegistry({
  initializeApp: (options, name) => {
    const app = { name: String(name), options, automaticDataCollectionEnabled: false };
    apps.set(app.name, app);
    return app as never;
  },
  getApp: (name) => apps.get(name ?? '[DEFAULT]') as never,
  getApps: () => [...apps.values()] as never,
  deleteApp: async () => {},
});
const initializeAppCheck = bridge.initializeAppCheck as (app: unknown, options: unknown) => unknown;
const provider = () => new sdk.CustomProvider({ getToken: async () => { throw new Error('not called in debug mode'); } });

async function generate(model: { generateContent(prompt: string): Promise<unknown> }) {
  try {
    await model.generateContent('Reply with exactly the word: pyric');
    return { threw: false };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { threw: true, code: e.code ?? null, message: String(e.message) };
  }
}

const app = registry.initializeApp(OPTIONS, 'refused');
initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
const generation = await generate(ai.getGenerativeModel(ai.getAI(app as never), { model: MODEL }));
const header = aiRequests[0] ?? null;

const limitedApp = registry.initializeApp(OPTIONS, 'refused-limited');
initializeAppCheck(limitedApp, { provider: provider(), isTokenAutoRefreshEnabled: false });
const before = aiRequests.length;
const limited = await generate(ai.getGenerativeModel(ai.getAI(limitedApp as never, { useLimitedUseAppCheckTokens: true }), { model: MODEL }));

console.log(JSON.stringify({
  aiRequest: { requestSeen: header !== undefined, appCheckHeaderIsSdkDummyToken: header === Buffer.from(JSON.stringify({ error: 'UNKNOWN_ERROR' })).toString('base64') },
  aiGeneration: generation,
  aiLimitedUseRequest: { requestSeen: aiRequests.length > before },
  aiLimitedUseGeneration: limited,
}));
process.exit(0);
