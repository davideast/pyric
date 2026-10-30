/**
 * App Check in sandbox AI mode (rows `ai#sandbox-app-check-*` in
 * packages/conformance/registry/ai.ts). From November 2, 2026 Firebase AI
 * Logic refuses requests without a valid App Check token; the sandbox broker
 * refuses the same requests with the same envelope, and the app gets the same
 * `AIError` the SDK throws for it.
 *
 * Expected values come from the captures: `app-check-ai-gate-wire` (the wire
 * envelope for each refused token), `app-check-client-ai-header` (the SDK
 * error for an app without App Check, and the limited-use token on each
 * request) and `app-check-client-get-token-before-initialize` (a handle built
 * before `initializeAppCheck` is refused).
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import { CustomProvider, getLimitedUseToken, getToken, initializeAppCheck, ReCaptchaV3Provider } from '../../src/app-check/index.js';
import { AIError, getAI, getGenerativeModel } from '../../src/ai/index.js';
import { AiBroker } from '../../src/ai/broker/broker.js';
import { AiBrokerError } from '../../src/ai/broker/synthesizer.js';
import type { AnswerEngine } from '../../src/ai/broker/types.js';
import { createTransportAI } from '../../src/ai/internal.js';
import { APP_CHECK_HINT } from '../../src/ai/app-check-gate.js';
import { mintAppCheckToken, signAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'app-check');
type Behavior = Record<string, any>;
const obs = (name: string): Behavior =>
  (JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as { behavior: Behavior }).behavior;

const gateWire = obs('app-check-ai-gate-wire');
const aiHeader = obs('app-check-client-ai-header');
const beforeInitialize = obs('app-check-client-get-token-before-initialize');

const MODEL = 'gemini-flash-lite-latest';
const OPTIONS = { apiKey: 'demo-api-key', appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4', projectId: 'genkit-idx' };
const SDK_PLACEHOLDER_TOKEN = Buffer.from(JSON.stringify({ error: 'UNKNOWN_ERROR' })).toString('base64');
const REQUEST = { contents: [{ role: 'user', parts: [{ text: 'Reply with exactly the word: pyric' }] }] };

const apps: FirebaseApp[] = [];
let appSeq = 0;
function newApp(): FirebaseApp {
  const app = createAppForSandbox(initializeSandbox(), OPTIONS, `app-check-gate-${++appSeq}`);
  apps.push(app);
  return app;
}

function withAppCheck(app: FirebaseApp) {
  return initializeAppCheck(app, { provider: new ReCaptchaV3Provider('site-key') });
}

let warn: ReturnType<typeof spyOn> | undefined;
afterEach(async () => {
  warn?.mockRestore();
  warn = undefined;
  delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  for (const app of apps.splice(0)) await deleteApp(app);
});

async function rejection(promise: Promise<unknown>): Promise<AIError> {
  try {
    await promise;
  } catch (error) {
    return error as AIError;
  }
  throw new Error('expected the request to be refused');
}

/** The SDK error the capture saw, with the sandbox's request URL in place of the oracle project's. */
function expectCapturedRefusal(error: AIError, op: string): void {
  const captured = aiHeader.noAppCheck.generation;
  const expectedMessage = (captured.message as string)
    .replace('projects/genkit-idx/', 'projects/sandbox/')
    .replace(':generateContent:', `:${op}:`);
  expect(error).toBeInstanceOf(AIError);
  expect(error.code).toBe(captured.code);
  expect(error.message).toBe(expectedMessage);
  expect(error.customErrorData?.status).toBe(gateWire.noHeader.httpStatus);
  expect(error.customErrorData?.statusText).toBe('Forbidden');
}

describe('ai#sandbox-app-check-required', () => {
  it('generateContent from getAI(app) with no App Check rejects with the AIError the SDK throws for the captured 403', async () => {
    const model = getGenerativeModel(getAI(newApp()), { model: MODEL });
    expectCapturedRefusal(await rejection(model.generateContent('ping')), 'generateContent');
    expect(aiHeader.noAppCheck.responseStatus).toBe(403);
  });

  it('the refusal logs pyric guidance once per app beside the SDK error', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    const model = getGenerativeModel(getAI(newApp()), { model: MODEL });
    await rejection(model.generateContent('one'));
    await rejection(model.generateContent('two'));
    const hints = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes(APP_CHECK_HINT));
    expect(hints).toHaveLength(1);
  });

  it('initializeAppCheck then getAI answers', async () => {
    const app = newApp();
    withAppCheck(app);
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const result = await model.generateContent('ping');
    expect(result.response.candidates?.[0]?.finishReason).toBe(gateWire.validAdminMintedToken.finishReason);
  });

  it('the debug provider path answers: FIREBASE_APPCHECK_DEBUG_TOKEN = true before initializeAppCheck', async () => {
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const app = newApp();
    withAppCheck(app);
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    expect((await model.generateContent('ping')).response.text().length).toBeGreaterThan(0);
  });

  it('chat sends are refused the same way', async () => {
    const chat = getGenerativeModel(getAI(newApp()), { model: MODEL }).startChat();
    expectCapturedRefusal(await rejection(chat.sendMessage('ping')), 'generateContent');
  });
});

describe('app-check#custom-provider-without-debug-token: AI Logic judges the provider token', () => {
  type ProviderToken = { token: string; expireTimeMillis: number };
  const hour = () => Date.now() + 3_600_000;

  function customApp(getTokenFromProvider: () => Promise<ProviderToken>) {
    const counter = { calls: 0 };
    const app = newApp();
    const provider = new CustomProvider({
      getToken: async () => {
        counter.calls += 1;
        return getTokenFromProvider();
      },
    });
    initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: false });
    return { app, counter };
  }

  it('a provider token the sandbox signed answers', async () => {
    const { app, counter } = customApp(() => mintAppCheckToken({ appId: OPTIONS.appId, projectId: OPTIONS.projectId }, 3600));
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    expect((await model.generateContent('ping')).response.text().length).toBeGreaterThan(0);
    expect(counter.calls).toBe(1);
  });

  it('a provider token that is not an App Check token is refused', async () => {
    const { app, counter } = customApp(async () => ({ token: 'not-an-app-check-token', expireTimeMillis: hour() }));
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    expectCapturedRefusal(await rejection(model.generateContent('ping')), 'generateContent');
    expectCapturedRefusal(await rejection(model.countTokens('ping')), 'countTokens');
    expect(counter.calls).toBe(1);
  });

  it('a provider that rejects sends the SDK placeholder, which is refused', async () => {
    const { app, counter } = customApp(async () => {
      throw new Error('attestation failed');
    });
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    expectCapturedRefusal(await rejection(model.generateContent('ping')), 'generateContent');
    expectCapturedRefusal(await rejection(model.generateContentStream('ping')), 'streamGenerateContent');
    expect(counter.calls).toBe(2);
  });

  // Upstream getLimitedUseToken has no placeholder: the rejection reaches
  // makeRequest's catch, which wraps it as AIError('error', 'Error fetching
  // from <url>: <message>') (@firebase/ai 2.12.0 getHeaders and makeRequest).
  it('with limited-use tokens, a provider that rejects fails the request with the SDK fetch wrapper', async () => {
    const attestation = new Error('attestation failed');
    const { app, counter } = customApp(async () => {
      throw attestation;
    });
    const model = getGenerativeModel(getAI(app, { useLimitedUseAppCheckTokens: true }), { model: MODEL });
    const ops: Array<[string, Promise<unknown>]> = [
      ['generateContent', model.generateContent('ping')],
      ['streamGenerateContent', model.generateContentStream('ping')],
      ['countTokens', model.countTokens('ping')],
    ];
    for (const [op, request] of ops) {
      const error = await rejection(request);
      const url = `https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/${MODEL}:${op}`;
      expect(error).toBeInstanceOf(AIError);
      expect(error.code).toBe('error');
      expect(error.message).toBe(`AI: Error fetching from ${url}: attestation failed (AI/error)`);
      expect(error.customErrorData).toBeUndefined();
      expect(error.stack).toBe(attestation.stack);
    }
    expect(counter.calls).toBe(3);
  });

  it('with limited-use tokens, a provider that rejects with an AbortError passes it through, as makeRequest does', async () => {
    const abort = new DOMException('stopped', 'AbortError');
    const { app } = customApp(async () => {
      throw abort;
    });
    const model = getGenerativeModel(getAI(app, { useLimitedUseAppCheckTokens: true }), { model: MODEL });
    const error: unknown = await rejection(model.generateContent('ping'));
    expect(error).toBe(abort);
  });

  it('a transport handle carries the provider token as given', async () => {
    // The worker bridge carries this claim to the worker's broker, which gates it.
    const claims: Array<string | null> = [];
    const recording: AnswerEngine = {
      async generateContent(_req, _model, appCheckClaim) {
        claims.push(appCheckClaim?.token ?? null);
        return { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'pyric' }] }, finishReason: 'STOP' }] };
      },
      streamGenerateContent() {
        return (async function* none() {})();
      },
      async countTokens() {
        return { totalTokens: 1, promptTokensDetails: [] };
      },
    };
    const { app: invalid } = customApp(async () => ({ token: 'not-an-app-check-token', expireTimeMillis: hour() }));
    const { app: failing } = customApp(async () => {
      throw new Error('attestation failed');
    });
    await getGenerativeModel(createTransportAI(invalid, undefined, recording), { model: MODEL }).generateContent('ping');
    await getGenerativeModel(createTransportAI(failing, undefined, recording), { model: MODEL }).generateContent('ping');
    expect(claims).toEqual(['not-an-app-check-token', SDK_PLACEHOLDER_TOKEN]);
  });

  it('under a debug token the provider is never called', async () => {
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const { app, counter } = customApp(async () => {
      throw new Error('not called');
    });
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    expect((await model.generateContent('ping')).response.text().length).toBeGreaterThan(0);
    expect(counter.calls).toBe(0);
  });
});

describe('ai#sandbox-app-check-initialize-after-getai', () => {
  it('getAI then initializeAppCheck is refused, though getToken works', async () => {
    const app = newApp();
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const appCheck = withAppCheck(app);
    expect(beforeInitialize.initializeAfterAi.threw).toBe(false);
    expect((await getToken(appCheck)).token.split('.')).toHaveLength(beforeInitialize.getTokenAfterLateInitialize.token.segmentCount);
    const error = await rejection(model.generateContent('ping'));
    expect(beforeInitialize.aiRequestAfterLateInitialize.appCheckHeaderPresent).toBe(false);
    expect(error.code).toBe(beforeInitialize.aiGenerationAfterLateInitialize.code);
    expect(error.message).toBe(
      (beforeInitialize.aiGenerationAfterLateInitialize.message as string).replace('projects/genkit-idx/', 'projects/sandbox/'),
    );
  });
});

describe('ai#sandbox-app-check-limited-use', () => {
  it('with useLimitedUseAppCheckTokens each request answers with a fresh limited-use token', async () => {
    const app = newApp();
    const appCheck = withAppCheck(app);
    const cached = (await getToken(appCheck)).token;
    const claims: Array<string | null> = [];
    const recording: AnswerEngine = {
      async generateContent(_req, _model, appCheckClaim) {
        claims.push(appCheckClaim?.token ?? null);
        return { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'pyric' }] }, finishReason: 'STOP' }] };
      },
      streamGenerateContent() {
        return (async function* none() {})();
      },
      async countTokens() {
        return { totalTokens: 1, promptTokensDetails: [] };
      },
    };
    const ai = createTransportAI(app, { useLimitedUseAppCheckTokens: true }, recording);
    const model = getGenerativeModel(ai, { model: MODEL });
    await model.generateContent('one');
    await model.generateContent('two');
    expect(aiHeader.limitedUseModel.headerTokenIsNewLimitedUse).toBe(true);
    expect(aiHeader.limitedUseModel.appCheckHeaderEquals.limitedUseAppCachedGetToken).toBe(false);
    expect(claims).toHaveLength(2);
    expect(claims[0]).not.toBe(claims[1]);
    expect(claims).not.toContain(cached);
    expect(claims).not.toContain(null);
    // Sanity: limited-use tokens are what getLimitedUseToken returns, shape for shape.
    expect(claims[0]!.split('.')).toHaveLength((await getLimitedUseToken(appCheck)).token.split('.').length);
  });

  it('a limited-use sandbox handle answers', async () => {
    const app = newApp();
    withAppCheck(app);
    const model = getGenerativeModel(getAI(app, { useLimitedUseAppCheckTokens: true }), { model: MODEL });
    expect((await model.generateContent('ping')).response.candidates?.length).toBeGreaterThan(0);
  });

  it('a transport handle sends no token when the app has no App Check', async () => {
    const claims: unknown[] = [];
    const recording = {
      async generateContent(_req: unknown, _model: string, appCheck: unknown) {
        claims.push(appCheck);
        throw new Error('stop');
      },
    } as unknown as AnswerEngine;
    const model = getGenerativeModel(createTransportAI(newApp(), undefined, recording), { model: MODEL });
    await rejection(model.generateContent('ping'));
    expect(claims).toEqual([{ token: null }]);
  });
});

describe('ai#sandbox-app-check-stream-and-count-tokens', () => {
  it('generateContentStream rejects before any chunk, as the SDK does for a 403', async () => {
    const model = getGenerativeModel(getAI(newApp()), { model: MODEL });
    expectCapturedRefusal(await rejection(model.generateContentStream('ping')), 'streamGenerateContent');
  });

  it('a malformed request with a valid token still rejects at the call on the in-process plane', async () => {
    const app = newApp();
    withAppCheck(app);
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const error = await rejection(model.generateContentStream({ contents: [] }));
    expect(error).toBeInstanceOf(AIError);
    expect(error.customErrorData?.status).not.toBe(gateWire.noHeader.httpStatus);
  });

  it('countTokens rejects the same way', async () => {
    const model = getGenerativeModel(getAI(newApp()), { model: MODEL });
    expectCapturedRefusal(await rejection(model.countTokens('ping')), 'countTokens');
  });

  it('stream and countTokens answer with App Check initialized first', async () => {
    const app = newApp();
    withAppCheck(app);
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const streamed = await model.generateContentStream('ping');
    expect((await streamed.response).candidates?.length).toBeGreaterThan(0);
    expect((await model.countTokens('ping')).totalTokens).toBeGreaterThan(0);
  });
});

describe('the broker gate', () => {
  const refusals = ['noHeader', 'malformedHeader', 'sdkPlaceholderToken', 'tamperedSignature'] as const;

  async function tokenFor(kind: (typeof refusals)[number] | 'expired'): Promise<string | null> {
    const valid = (await mintAppCheckToken(OPTIONS, 3600)).token;
    switch (kind) {
      case 'noHeader': return null;
      case 'malformedHeader': return 'not-a-token';
      case 'sdkPlaceholderToken': return SDK_PLACEHOLDER_TOKEN;
      case 'tamperedSignature': {
        const last = valid.at(-1) === 'A' ? 'B' : 'A';
        return `${valid.slice(0, -1)}${last}`;
      }
      case 'expired': {
        const now = Math.floor(Date.now() / 1000);
        return signAppCheckToken({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' }, {
          sub: OPTIONS.appId, aud: [], provider: 'pyric-sandbox', iss: 'x', iat: now - 7200, exp: now - 3600, jti: 'expired',
        });
      }
    }
  }

  for (const kind of [...refusals, 'expired'] as const) {
    it(`refuses a ${kind} token with the captured envelope, before any engine runs`, async () => {
      let engineCalls = 0;
      const broker = new AiBroker({
        engine: {
          async generateContent() { engineCalls++; return { candidates: [] }; },
          streamGenerateContent() { engineCalls++; return (async function* none() {})(); },
          async countTokens() { engineCalls++; return { totalTokens: 0, promptTokensDetails: [] }; },
        },
      });
      const token = await tokenFor(kind);
      const expected = kind === 'expired' ? gateWire.noHeader.raw : gateWire[kind].raw;
      const error = await broker.generateContent(REQUEST, `models/${MODEL}`, { token }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiBrokerError);
      expect((error as AiBrokerError).envelope).toEqual(expected);
      const counted = await broker.countTokens(REQUEST, `models/${MODEL}`, { token }).catch((e: unknown) => e);
      expect((counted as AiBrokerError).envelope).toEqual(expected);
      const streamed = await (async () => {
        for await (const _chunk of broker.streamGenerateContent(REQUEST, `models/${MODEL}`, { token })) { /* none */ }
      })().catch((e: unknown) => e);
      expect((streamed as AiBrokerError).envelope).toEqual(expected);
      expect(engineCalls).toBe(0);
    });
  }

  it('admits a valid sandbox token, whichever plane minted it', async () => {
    const broker = new AiBroker();
    const token = (await mintAppCheckToken(OPTIONS, 3600)).token;
    const response = await broker.generateContent(REQUEST, `models/${MODEL}`, { token });
    expect(response.candidates?.[0]?.finishReason).toBe(gateWire.validAdminMintedToken.finishReason);
  });

  it('the refusal event carries pyric guidance beside production message', async () => {
    const sandbox = initializeSandbox();
    const events: Array<Record<string, unknown>> = [];
    sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'ai') events.push(event.detail as Record<string, unknown>);
    });
    const broker = new AiBroker({ sandbox });
    await broker.generateContent(REQUEST, `models/${MODEL}`, { token: null }).catch(() => undefined);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ code: 403, status: 'PERMISSION_DENIED', message: gateWire.noHeader.messageText, hint: APP_CHECK_HINT });
  });

  it('a stream with no token and a malformed request gets the 403, as generateContent does', async () => {
    const malformed = { contents: [] };
    const model = `models/${MODEL}`;
    const broker = new AiBroker();
    const code = async (run: () => Promise<unknown>): Promise<number> => {
      try {
        await run();
      } catch (error) {
        return (error as AiBrokerError).envelope.error.code;
      }
      throw new Error('expected a refusal');
    };
    const stream = () => (async () => {
      for await (const _chunk of broker.streamGenerateContent(malformed, model, { token: null })) { /* none */ }
    })();
    expect(await code(stream)).toBe(403);
    expect(await code(() => broker.generateContent(malformed, model, { token: null }))).toBe(403);
    expect(await code(() => broker.countTokens(malformed, model, { token: null }))).toBe(403);
  });
});

describe('handles with no app', () => {
  it('getAI(sandbox) is not gated', async () => {
    const model = getGenerativeModel(getAI(initializeSandbox()), { model: MODEL });
    expect((await model.generateContent('ping')).response.candidates?.length).toBeGreaterThan(0);
    expect((await model.countTokens('ping')).totalTokens).toBeGreaterThan(0);
  });

  it('a broker request with no claim is not gated', async () => {
    const response = await new AiBroker().generateContent(REQUEST, `models/${MODEL}`);
    expect(response.candidates?.length).toBeGreaterThan(0);
  });
});
