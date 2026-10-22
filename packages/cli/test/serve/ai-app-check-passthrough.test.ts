/**
 * App Check on the production AI path (rows `ai#app-check-*` in
 * packages/conformance/registry/ai.ts), authored red under Conformance Driven
 * Development (docs/conformance/cdd.md, Step 3).
 *
 * Each assertion set checks pyric's half of the claim, that production AI mode
 * leaves `firebase/app-check` to the Firebase SDK on every plane and that the
 * SDK attaches to the bridged app, and then replays the cited `app-check-`
 * capture: the real `firebase/app-check` and `firebase/ai` run on an app from
 * the served `app-ai-passthrough` entry, with `fetch` answered from the
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

async function bridged() {
  const entry = await import('../../src/serve/entries/app-ai-passthrough.js');
  const realAppCheck = await import('firebase/app-check');
  const realAi = await import('firebase/ai');
  appSeq += 1;
  const app = entry.initializeApp(OPTIONS, `ai-app-check-${appSeq}`);
  const provider = new realAppCheck.CustomProvider({
    getToken: async () => {
      if (failAttestation) throw new Error('attestation refused');
      const token = `sandbox-token-${appSeq}-${minted.size}`;
      minted.add(token);
      return { token, expireTimeMillis: Date.now() + 3_600_000 };
    },
  });
  return { app, provider, appCheck: realAppCheck, ai: realAi };
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
  expect(swappedFirebaseEntries('production').has('firebase/app-check')).toBe(false);
  expect(swappedFirebaseEntries('sandbox').get('firebase/app-check')).toBe('app-check');
  expect(mapFirebaseSpecifier('firebase/app-check', undefined, { aiMode: 'production', sandbox: '' })).toBeNull();
  expect(mapFirebaseSpecifier('firebase/app-check', undefined, { aiMode: 'sandbox', sandbox: '' })).toBe('pyric/app-check');
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
    let handle: ReturnType<typeof appCheck.initializeAppCheck> | undefined;
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
    const { app, provider, appCheck, ai } = await bridged();
    appCheck.initializeAppCheck(app as never, { provider, isTokenAutoRefreshEnabled: false });
    failAttestation = true;
    const generation = await generate(ai.getGenerativeModel(ai.getAI(app as never), { model: MODEL }));
    expect(seen[0]?.appCheckHeader === SDK_DUMMY_TOKEN).toBe(o.aiRequest.appCheckHeaderIsSdkDummyToken);
    expect(generation.threw).toBe(o.aiGeneration.threw);
    seen.length = 0;
    const limitedApp = await bridged();
    appCheck.initializeAppCheck(limitedApp.app as never, { provider: limitedApp.provider, isTokenAutoRefreshEnabled: false });
    const limited = await generate(ai.getGenerativeModel(ai.getAI(limitedApp.app as never, { useLimitedUseAppCheckTokens: true }), { model: MODEL }));
    expect(seen.length > 0).toBe(o.aiLimitedUseRequest.requestSeen);
    expect((limited as { code: string }).code).toBe(o.aiLimitedUseGeneration.code);
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
});
