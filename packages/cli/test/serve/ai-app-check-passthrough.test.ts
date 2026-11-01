/**
 * App Check on the production AI path (rows `ai#app-check-*` in
 * packages/conformance/registry/ai.ts), authored red under Conformance Driven
 * Development (docs/conformance/cdd.md, Step 3).
 *
 * Each assertion set checks pyric's half of the claim, that production AI mode
 * leaves `firebase/app-check` to the Firebase SDK on every plane and that the
 * SDK attaches to the bridged app, and then replays the cited `app-check-`
 * capture: the real `firebase/app-check` and `firebase/ai` run on an app from
 * the served `app-ai-passthrough` entry through the served App Check bridge
 * (`register/app-bridge-app-check`), with `fetch` answered from the
 * capture so nothing reaches Google. The provider is a `CustomProvider`, so no
 * attestation service is contacted either.
 *
 * Blocking run: only expected-green rows run. The climb lane (`PYRIC_CLIMB=1`)
 * runs every row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appCheckAiRows } from '../../../conformance/registry/ai.ts';
import { swappedFirebaseEntries } from '../../src/serve/firebase-module-swap.js';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';

const isClimb = process.env.PYRIC_CLIMB === '1';
const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check');
type Behavior = Record<string, any>;
const obs = (name: string): Behavior =>
  (JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as { behavior: Behavior }).behavior;

const SDK_DUMMY_TOKEN = Buffer.from(JSON.stringify({ error: 'UNKNOWN_ERROR' })).toString('base64');
const OPTIONS = { apiKey: 'demo-api-key', appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4', projectId: 'genkit-idx' };
const MODEL = 'gemini-flash-lite-latest';

interface SeenRequest { appCheckHeader: string | null }
const seen: SeenRequest[] = [];
const realFetch = globalThis.fetch;
let deniedBody: unknown;

/** Answers AI Logic the way the captures saw it: 200 with a valid token, the captured 403 otherwise. */
function installFetch(validTokens: () => Set<string>): void {
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const appCheckHeader = headers.get('x-firebase-appcheck');
    seen.push({ appCheckHeader });
    const valid = appCheckHeader !== null && validTokens().has(appCheckHeader);
    if (!valid) return new Response(JSON.stringify(deniedBody), { status: 403, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'pyric' }] }, finishReason: 'STOP' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

let appSeq = 0;
const minted = new Set<string>();
let failAttestation = false;

/**
 * A Pyric-shaped app decorated with its shadow Firebase app by the shared
 * pass-through registry (`register/app-bridge-shadow`), the decoration the
 * served `app-ai-passthrough` entry and the register adapter both apply. A
 * minimal registry stands in for the Pyric one so this suite binds no sandbox.
 */
async function bridged() {
  const { shadowedAppRegistry } = await import('../../src/register/app-bridge-shadow.js');
  // What production AI mode serves for `firebase/app-check` on every plane.
  const bridge = await import('../../src/register/app-bridge-app-check.js');
  const sdk = await import('firebase/app-check');
  const realAi = await import('firebase/ai');
  const pyricLike = new Map<string, { name: string; options: typeof OPTIONS; automaticDataCollectionEnabled: boolean }>();
  const registry = shadowedAppRegistry({
    initializeApp: (options, name) => {
      const app = { name: String(name), options: options as typeof OPTIONS, automaticDataCollectionEnabled: false };
      pyricLike.set(app.name, app);
      return app as never;
    },
    getApp: (name) => pyricLike.get(name ?? '[DEFAULT]') as never,
    getApps: () => [...pyricLike.values()] as never,
    deleteApp: async () => {},
  });
  appSeq += 1;
  const app = registry.initializeApp(OPTIONS, `ai-app-check-${appSeq}`);
  const provider = new sdk.CustomProvider({
    getToken: async () => {
      if (failAttestation) throw new Error('attestation refused');
      const token = `sandbox-token-${appSeq}-${minted.size}`;
      minted.add(token);
      return { token, expireTimeMillis: Date.now() + 3_600_000 };
    },
  });
  const appCheck = {
    initializeAppCheck: bridge.initializeAppCheck as (app: unknown, options: unknown) => import('firebase/app-check').AppCheck,
    getToken: bridge.getToken as typeof sdk.getToken,
  };
  return { app, provider, appCheck, ai: realAi };
}
async function generate(model: { generateContent(prompt: string): Promise<{ response: { candidates?: { finishReason?: string }[] } }> }) {
  try {
    const result = await model.generateContent('Reply with exactly the word: pyric');
    return { threw: false, value: { finishReason: result.response.candidates?.[0]?.finishReason ?? null } };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { threw: true, code: e.code ?? null, message: String(e.message) };
  }
}

beforeAll(() => {
  deniedBody = obs('app-check-ai-gate-wire').noHeader.raw;
  installFetch(() => minted);
});
afterEach(() => {
  seen.length = 0;
  failAttestation = false;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function assertPassthroughRouting(): void {
  // Browser planes (Vite and the import map) and the register agree.
  expect(swappedFirebaseEntries('production').get('firebase/app-check')).toBe('app-ai-passthrough-app-check');
  expect(swappedFirebaseEntries('sandbox').get('firebase/app-check')).toBe('app-check');
  expect(mapFirebaseSpecifier('firebase/app-check', undefined, { aiMode: 'production', sandbox: '' })).toBe('@pyric/cli/register/app-bridge-app-check');
  expect(mapFirebaseSpecifier('firebase/app-check', undefined, { aiMode: 'sandbox', sandbox: '' })).toBe('pyric/app-check');
  // The wrapper's own SDK imports reach the Firebase SDK.
  expect(mapFirebaseSpecifier('firebase/app-check', join(import.meta.dir, '..', '..', 'src', 'register', 'app-bridge-app-check.ts'), { aiMode: 'production', sandbox: '' })).toBeNull();
}

const assertions: Record<string, () => Promise<void>> = {
  'ai#app-check-passthrough-header': async () => {
    const o = obs('app-check-client-ai-header').appCheckInitialized;
    assertPassthroughRouting();
    const { app, provider, appCheck, ai } = await bridged();
    const handle = appCheck.initializeAppCheck(app as never, { provider, isTokenAutoRefreshEnabled: false });
    const { token } = await appCheck.getToken(handle);
    const generation = await generate(ai.getGenerativeModel(ai.getAI(app as never), { model: MODEL }));
    expect(Boolean(seen[0]?.appCheckHeader)).toBe(o.appCheckHeaderPresent);
    expect(seen[0]?.appCheckHeader === token).toBe(o.appCheckHeaderEquals.cachedGetToken);
    expect(generation).toEqual(o.generation);
  },

  'ai#app-check-passthrough-limited-use': async () => {
    const o = obs('app-check-client-ai-header').limitedUseModel;
    assertPassthroughRouting();
    const { app, provider, appCheck, ai } = await bridged();
    const handle = appCheck.initializeAppCheck(app as never, { provider, isTokenAutoRefreshEnabled: false });
    const { token } = await appCheck.getToken(handle);
    const generation = await generate(ai.getGenerativeModel(ai.getAI(app as never, { useLimitedUseAppCheckTokens: true }), { model: MODEL }));
    expect(Boolean(seen[0]?.appCheckHeader)).toBe(o.appCheckHeaderPresent);
    expect(Boolean(seen[0]?.appCheckHeader) && seen[0]!.appCheckHeader !== token).toBe(o.headerTokenIsNewLimitedUse);
    expect(generation).toEqual(o.generation);
  },

  'ai#app-check-required': async () => {
    const o = obs('app-check-client-ai-header').noAppCheck;
    const wire = obs('app-check-ai-gate-wire');
    const { app, ai } = await bridged();
    const generation = await generate(ai.getGenerativeModel(ai.getAI(app as never), { model: MODEL }));
    expect(Boolean(seen[0]?.appCheckHeader)).toBe(o.appCheckHeaderPresent);
    expect(generation.threw).toBe(o.generation.threw);
    expect((generation as { code: string }).code).toBe(o.generation.code);
    expect((generation as { message: string }).message).toContain(wire.noHeader.messageText);
    for (const failing of ['malformedHeader', 'sdkPlaceholderToken', 'tamperedSignature']) {
      expect(wire[failing].messageText).toBe(wire.noHeader.messageText);
    }
    expect(wire.validAdminMintedToken.httpStatus).toBe(200);
  },

  'ai#app-check-initialize-after-getai': async () => {
    const o = obs('app-check-client-get-token-before-initialize');
    const { app, provider, appCheck, ai } = await bridged();
    const model = ai.getGenerativeModel(ai.getAI(app as never), { model: MODEL });
    let initializeThrew = false;
    let handle: import('firebase/app-check').AppCheck | undefined;
    try {
      handle = appCheck.initializeAppCheck(app as never, { provider, isTokenAutoRefreshEnabled: false });
    } catch {
      initializeThrew = true;
    }
    expect({ threw: initializeThrew }).toEqual(o.initializeAfterAi);
    const late = await appCheck.getToken(handle!);
    expect(Object.keys(late).sort()).toEqual(o.getTokenAfterLateInitialize.keySet);
    const generation = await generate(model);
    expect(Boolean(seen[0]?.appCheckHeader)).toBe(o.aiRequestAfterLateInitialize.appCheckHeaderPresent);
    expect(generation.threw).toBe(o.aiGenerationAfterLateInitialize.threw);
  },

  'ai#app-check-attestation-failure': async () => {
    const o = obs('app-check-client-invalid-debug-token');
    // Debug mode is module-wide in the App Check SDK, so the refusal replays in
    // its own process (fixtures/app-check-debug-refusal.ts).
    const child = Bun.spawnSync(['bun', join(import.meta.dir, 'fixtures', 'app-check-debug-refusal.ts')], { stdout: 'pipe', stderr: 'pipe' });
    const line = child.stdout.toString().trim().split('\n').filter((l) => l.startsWith('{')).at(-1) ?? '';
    expect(line, child.stderr.toString()).not.toBe('');
    const replay = JSON.parse(line) as Behavior;
    const facts = (g: Behavior) => ({ threw: g.threw, code: g.code, message: g.message });
    expect(replay.aiRequest).toEqual({ requestSeen: o.aiRequest.requestSeen, appCheckHeaderIsSdkDummyToken: o.aiRequest.appCheckHeaderIsSdkDummyToken });
    expect(facts(replay.aiGeneration)).toEqual(facts(o.aiGeneration));
    expect(replay.aiLimitedUseRequest.requestSeen).toBe(o.aiLimitedUseRequest.requestSeen);
    expect(facts(replay.aiLimitedUseGeneration)).toEqual(facts(o.aiLimitedUseGeneration));
  },
};

const isExpectedGreen = (status: string) => status === 'conforms' || status === 'diverged-documented';

describe('App Check on the AI path (production AI pass-through)', () => {
  for (const row of appCheckAiRows) {
    const register = isExpectedGreen(row.status) || isClimb ? it : it.skip;
    register(`${row.id} ${row.api}`, async () => {
      const assertion = assertions[row.id];
      if (!assertion) throw new Error(`no assertion set authored for ${row.id}`);
      await assertion();
    });
  }

  it('completeness: one assertion set per App Check AI row', () => {
    expect(Object.keys(assertions).sort()).toEqual(appCheckAiRows.map((row) => row.id).sort());
  });

  it('the served firebase/app entry and the register bridge share one shadow registry', async () => {
    const served = await import('../../src/serve/entries/app-ai-passthrough.js');
    // Pyric allows one Firebase configuration per runtime; other suites in this process bind theirs.
    const { resetAppRegistryForTests } = await import('pyric/app/internal');
    await resetAppRegistryForTests();
    const { shadowAppOf } = await import('../../src/register/app-bridge-shadow.js');
    const sdkApp = await import('firebase/app');
    const sdk = await import('firebase/app-check');
    const bridge = await import('../../src/register/app-bridge-app-check.js');
    const name = `served-shadow-${++appSeq}`;
    const app = served.initializeApp(OPTIONS, name);
    try {
      const shadow = shadowAppOf(app) as { container?: unknown };
      expect(shadow).toBe(sdkApp.getApp(name));
      expect((app as unknown as { container?: unknown }).container).toBe(shadow.container);
      const provider = new sdk.CustomProvider({ getToken: async () => ({ token: 'served-token', expireTimeMillis: Date.now() + 3_600_000 }) });
      const handle = (bridge.initializeAppCheck as (app: unknown, options: unknown) => { app: unknown })(app, { provider, isTokenAutoRefreshEnabled: false });
      expect(handle.app).toBe(shadow);
    } finally {
      await served.deleteApp(app);
      await resetAppRegistryForTests();
    }
    expect(() => sdkApp.getApp(name)).toThrow();
  });
});
