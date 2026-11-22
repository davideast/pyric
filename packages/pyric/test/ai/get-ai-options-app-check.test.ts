import { afterEach, describe, expect, it } from 'bun:test';
import { deleteApp, getApps, type FirebaseApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import {
  CustomProvider,
  getToken,
  initializeAppCheck,
  type AppCheck,
} from '../../src/app-check/index.js';
import {
  AIError,
  AIErrorCode,
  VertexAIBackend,
  getAI,
  getGenerativeModel,
} from '../../src/ai/index.js';
import { createTransportAI } from '../../src/ai/internal.js';
import type { AnswerEngine } from '../../src/ai/broker/types.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';

const MODEL = 'gemini-flash-lite-latest';
const APP_ID = '1:123456789012:web:abcdef0123456789';
const PROJECT_ID = 'demo-ai-options';
const VALID_OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: PROJECT_ID,
  appId: APP_ID,
};

let seq = 0;
const createdApps: FirebaseApp[] = [];
const createdSandboxes: Array<ReturnType<typeof initializeSandbox>> = [];

function makeSandboxApp(
  options: Record<string, unknown> = VALID_OPTIONS,
): FirebaseApp {
  const sandbox = initializeSandbox();
  createdSandboxes.push(sandbox);
  const app = createAppForSandbox(sandbox, options, `ai-opts-${++seq}`);
  createdApps.push(app);
  return app;
}

function attachCountingAppCheck(app: FirebaseApp): {
  appCheck: AppCheck;
  getCallCount: () => number;
} {
  let calls = 0;
  const appCheck = initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => {
        calls += 1;
        return mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600);
      },
    }),
    isTokenAutoRefreshEnabled: false,
  });
  return { appCheck, getCallCount: () => calls };
}

afterEach(async () => {
  let app = createdApps.pop();
  while (app !== undefined) {
    try {
      await deleteApp(app);
    } catch {
      // Already deleted by test.
    }
    app = createdApps.pop();
  }
  await Promise.all(getApps().map((liveApp) => deleteApp(liveApp)));
  let sandbox = createdSandboxes.pop();
  while (sandbox !== undefined) {
    sandbox.dispose();
    sandbox = createdSandboxes.pop();
  }
});

describe('getAI latest useLimitedUseAppCheckTokens option (#1910)', () => {
  it('updates ai.options on every in-page getAI call while models keep the mode active when built', async () => {
    const app = makeSandboxApp();
    const { appCheck, getCallCount } = attachCountingAppCheck(app);
    const cachedToken = (await getToken(appCheck)).token;
    expect(getCallCount()).toBe(1);

    const firstAi = getAI(app);
    expect(firstAi.options).toEqual({ useLimitedUseAppCheckTokens: false });
    const cachedModel = getGenerativeModel(firstAi, { model: MODEL });

    const secondAi = getAI(app, { useLimitedUseAppCheckTokens: true });
    expect(secondAi).toBe(firstAi);
    expect(firstAi.options).toEqual({ useLimitedUseAppCheckTokens: true });
    const limitedUseModel = getGenerativeModel(secondAi, { model: MODEL });

    const thirdAi = getAI(app);
    expect(thirdAi).toBe(firstAi);
    expect(firstAi.options).toEqual({ useLimitedUseAppCheckTokens: false });
    const revertedCachedModel = getGenerativeModel(thirdAi, { model: MODEL });

    // cachedModel (built before secondAi) still reuses the cached token.
    await cachedModel.generateContent('one');
    expect(getCallCount()).toBe(1);

    // limitedUseModel (built after secondAi) mints fresh tokens across ops and chat.
    await limitedUseModel.generateContent('two');
    expect(getCallCount()).toBe(2);
    await limitedUseModel.countTokens('three');
    expect(getCallCount()).toBe(3);
    const streamResult = await limitedUseModel.generateContentStream('four');
    await streamResult.response;
    expect(getCallCount()).toBe(4);
    await limitedUseModel.startChat().sendMessage('five');
    expect(getCallCount()).toBe(5);

    // revertedCachedModel (built after thirdAi omitted options) reuses cachedToken again.
    await revertedCachedModel.generateContent('six');
    expect(getCallCount()).toBe(5);
    expect((await getToken(appCheck)).token).toBe(cachedToken);
  });

  it('updates ai.options on every createTransportAI call and isolates options per backend', async () => {
    const app = makeSandboxApp();
    const { appCheck } = attachCountingAppCheck(app);
    const cachedToken = (await getToken(appCheck)).token;

    const observedTokens: Array<string | null> = [];
    const transport: AnswerEngine = {
      async generateContent(_req, _model, claim) {
        observedTokens.push(claim?.token ?? null);
        return {
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
            },
          ],
        };
      },
      streamGenerateContent(_req, _model, claim) {
        observedTokens.push(claim?.token ?? null);
        return (async function* chunks() {
          yield {
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'ok' }] },
                finishReason: 'STOP',
              },
            ],
          };
        })();
      },
      async countTokens(_req, _model, claim) {
        observedTokens.push(claim?.token ?? null);
        return { totalTokens: 1, promptTokensDetails: [] };
      },
    };

    const aiInitial = createTransportAI(app, undefined, transport);
    expect(aiInitial.options).toEqual({ useLimitedUseAppCheckTokens: false });
    const initialModel = getGenerativeModel(aiInitial, { model: MODEL });

    const aiLimited = createTransportAI(
      app,
      { useLimitedUseAppCheckTokens: true },
      transport,
    );
    expect(aiLimited).toBe(aiInitial);
    expect(aiLimited.options).toEqual({ useLimitedUseAppCheckTokens: true });
    const limitedModel = getGenerativeModel(aiLimited, { model: MODEL });

    // Separate Vertex backend handle keeps its own options independently.
    const vertexAi = createTransportAI(
      app,
      { backend: new VertexAIBackend('europe-west1'), useLimitedUseAppCheckTokens: false },
      transport,
    );
    expect(vertexAi).not.toBe(aiLimited);
    expect(vertexAi.options).toEqual({ useLimitedUseAppCheckTokens: false });
    expect(aiLimited.options).toEqual({ useLimitedUseAppCheckTokens: true });

    const aiReverted = createTransportAI(
      app,
      { useLimitedUseAppCheckTokens: false },
      transport,
    );
    expect(aiReverted).toBe(aiInitial);
    expect(aiReverted.options).toEqual({ useLimitedUseAppCheckTokens: false });
    const revertedModel = getGenerativeModel(aiReverted, { model: MODEL });

    await initialModel.generateContent('a');
    await limitedModel.generateContent('b');
    await limitedModel.countTokens('c');
    await revertedModel.generateContent('d');

    expect(observedTokens).toHaveLength(4);
    expect(observedTokens[0]).toBe(cachedToken);
    expect(observedTokens[1]).not.toBe(cachedToken);
    expect(observedTokens[2]).not.toBe(cachedToken);
    expect(observedTokens[1]).not.toBe(observedTokens[2]);
    expect(observedTokens[3]).toBe(cachedToken);
  });
});

describe('initApiSettings required Firebase config validation (#1912)', () => {
  it('throws NO_API_KEY, NO_PROJECT_ID, and NO_APP_ID in @firebase/ai order on in-page and transport handles', () => {
    const transport: AnswerEngine = {
      async generateContent() {
        throw new Error('must fail before any request');
      },
      streamGenerateContent() {
        throw new Error('must fail before any request');
      },
      async countTokens() {
        throw new Error('must fail before any request');
      },
    };

    // Precedence check: when all three are missing, NO_API_KEY wins; when apiKey is set, NO_PROJECT_ID wins; then NO_APP_ID.
    const emptyConfigApp = makeSandboxApp({});
    const onlyApiKeyApp = makeSandboxApp({ apiKey: 'fake-key' });
    const missingAppIdApp = makeSandboxApp({ apiKey: 'fake-key', projectId: 'demo-proj' });

    for (const buildAi of [
      (app: FirebaseApp) => getAI(app),
      (app: FirebaseApp) => createTransportAI(app, undefined, transport),
    ]) {
      let err1: unknown;
      try {
        getGenerativeModel(buildAi(emptyConfigApp), { model: MODEL });
      } catch (e) {
        err1 = e;
      }
      expect(err1).toBeInstanceOf(AIError);
      expect((err1 as AIError).code).toBe(AIErrorCode.NO_API_KEY);
      expect((err1 as AIError).message).toBe(
        'AI: The "apiKey" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid API key. (AI/no-api-key)',
      );

      let err2: unknown;
      try {
        getGenerativeModel(buildAi(onlyApiKeyApp), { model: MODEL });
      } catch (e) {
        err2 = e;
      }
      expect(err2).toBeInstanceOf(AIError);
      expect((err2 as AIError).code).toBe(AIErrorCode.NO_PROJECT_ID);
      expect((err2 as AIError).message).toBe(
        'AI: The "projectId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid project ID. (AI/no-project-id)',
      );

      let err3: unknown;
      try {
        getGenerativeModel(buildAi(missingAppIdApp), { model: MODEL });
      } catch (e) {
        err3 = e;
      }
      expect(err3).toBeInstanceOf(AIError);
      expect((err3 as AIError).code).toBe(AIErrorCode.NO_APP_ID);
      expect((err3 as AIError).message).toBe(
        'AI: The "appId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid app ID. (AI/no-app-id)',
      );
    }
  });
});
