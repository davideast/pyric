import { describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
} from 'firebase/app';
import {
  AgentPlatformBackend as UpstreamAgentPlatformBackend,
  Backend as UpstreamBackend,
  BackendType as UpstreamBackendType,
  GoogleAIBackend as UpstreamGoogleAIBackend,
  getAI as getUpstreamAI,
  getGenerativeModel as getUpstreamGenerativeModel,
} from 'firebase/ai';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import {
  AIError,
  AIErrorCode,
  AgentPlatformBackend,
  Backend,
  BackendType,
  GoogleAIBackend,
  getAI,
  getGenerativeModel,
} from '../../src/ai/index.js';
import { createTransportAI } from '../../src/ai/internal.js';
import { script } from '../../src/ai/scripting.js';
import { CustomProvider, initializeAppCheck } from '../../src/app-check/index.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';
import { initializeSandbox } from 'pyric/sandbox';

describe('AgentPlatformBackend and BackendType.AGENT_PLATFORM parity (#1674)', () => {
  it('matches upstream constructor defaults, Backend inheritance, and location normalization', () => {
    const defaultBackend = new AgentPlatformBackend();
    const emptyLocationBackend = new AgentPlatformBackend('');
    const regionalBackend = new AgentPlatformBackend('us-central1');

    const upDefault = new UpstreamAgentPlatformBackend();
    const upEmpty = new UpstreamAgentPlatformBackend('');
    const upRegional = new UpstreamAgentPlatformBackend('us-central1');

    expect(defaultBackend instanceof Backend).toBe(upDefault instanceof UpstreamBackend);
    expect(defaultBackend instanceof AgentPlatformBackend).toBe(true);
    expect(defaultBackend instanceof GoogleAIBackend).toBe(false);

    expect(defaultBackend.backendType).toBe(BackendType.AGENT_PLATFORM);
    expect(defaultBackend.backendType).toBe(upDefault.backendType);
    expect(BackendType.AGENT_PLATFORM).toBe(UpstreamBackendType.AGENT_PLATFORM);

    expect(defaultBackend.location).toBe('global');
    expect(defaultBackend.location).toBe(upDefault.location);
    expect(emptyLocationBackend.location).toBe('global');
    expect(emptyLocationBackend.location).toBe(upEmpty.location);
    expect(regionalBackend.location).toBe('us-central1');
    expect(regionalBackend.location).toBe(upRegional.location);
  });

  it('keys getAI and createTransportAI handles by backend and location, and rejects invalid backendType', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'sandbox',
        appId: '1:100000000000:web:agentplat01',
      },
      `agent-plat-${Math.random().toString(36).slice(2, 10)}`,
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () =>
          mintAppCheckToken(
            { appId: '1:100000000000:web:agentplat01', projectId: 'sandbox' },
            3600,
          ),
      }),
    });

    try {
      const googleAi = getAI(app, { backend: new GoogleAIBackend() });
      const globalDefaultAi = getAI(app, { backend: new AgentPlatformBackend() });
      const globalExplicitAi = getAI(app, { backend: new AgentPlatformBackend('global') });
      const globalEmptyAi = getAI(app, { backend: new AgentPlatformBackend('') });
      const usCentralAi = getAI(app, { backend: new AgentPlatformBackend('us-central1') });

      expect(globalDefaultAi).not.toBe(googleAi);
      expect(globalDefaultAi).toBe(globalExplicitAi);
      expect(globalDefaultAi).toBe(globalEmptyAi);
      expect(globalDefaultAi).not.toBe(usCentralAi);
      expect(globalDefaultAi.backend).toBeInstanceOf(AgentPlatformBackend);
      expect((globalDefaultAi.backend as AgentPlatformBackend).location).toBe('global');
      expect((usCentralAi.backend as AgentPlatformBackend).location).toBe('us-central1');

      // Shared sandbox broker answers across both GoogleAIBackend and AgentPlatformBackend handles.
      script(googleAi, [
        { respond: { text: 'reply-global' } },
        { respond: { chunks: ['stream-', 'regional'] } },
      ]);
      const globalModel = getGenerativeModel(globalDefaultAi, { model: 'gemini-2.5-flash' });
      const usModel = getGenerativeModel(usCentralAi, { model: 'models/gemini-2.5-flash' });
      const customPubModel = getGenerativeModel(usCentralAi, {
        model: 'publishers/acme/models/custom-1',
      });
      const tunedModel = getGenerativeModel(usCentralAi, {
        model: 'tunedModels/my-tuned-model',
      });

      expect(globalModel.model).toBe('publishers/google/models/gemini-2.5-flash');
      expect(usModel.model).toBe('publishers/google/models/gemini-2.5-flash');
      expect(customPubModel.model).toBe('publishers/acme/models/custom-1');
      expect(tunedModel.model).toBe('tunedModels/my-tuned-model');

      const genRes = await globalModel.generateContent('hello');
      expect(genRes.response.text()).toBe('reply-global');

      const streamRes = await usModel.generateContentStream('hello stream');
      expect((await streamRes.response).text()).toBe('stream-regional');

      const tokenRes = await globalModel.countTokens('count me');
      expect(tokenRes.totalTokens).toBeGreaterThan(0);

      // Invalid backendType throws AIError(AIErrorCode.ERROR, ...) matching upstream encodeInstanceIdentifier.
      let invalidErr: unknown;
      try {
        getAI(app, { backend: { backendType: 'VERTEX_AI' as BackendType } as Backend });
      } catch (err) {
        invalidErr = err;
      }
      expect(invalidErr).toBeInstanceOf(AIError);
      expect((invalidErr as AIError).code).toBe(AIErrorCode.ERROR);
      expect((invalidErr as AIError).message).toContain('Invalid backend: "VERTEX_AI"');

      // Transport target parity for worker/served mode.
      const dummyTransport = {
        async generateContent() {
          return { candidates: [] };
        },
        streamGenerateContent() {
          return (async function* empty() {})();
        },
        async countTokens() {
          return { totalTokens: 0, promptTokensDetails: [] };
        },
      };
      const tGlobal1 = createTransportAI(app, { backend: new AgentPlatformBackend() }, dummyTransport);
      const tGlobal2 = createTransportAI(app, { backend: new AgentPlatformBackend('global') }, dummyTransport);
      const tEuro = createTransportAI(app, { backend: new AgentPlatformBackend('europe-west1') }, dummyTransport);
      expect(tGlobal1).toBe(tGlobal2);
      expect(tGlobal1).not.toBe(tEuro);
      expect(() =>
        createTransportAI(
          app,
          { backend: { backendType: 'BAD' as BackendType } as Backend },
          dummyTransport,
        ),
      ).toThrow(AIError);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('produces identical fetch-error request URLs to upstream firebase/ai across global, regional, publisher, and tuned models', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 404, message: 'model missing', status: 'NOT_FOUND' } }),
          {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'application/json' },
          },
        ),
      { preconnect: origFetch.preconnect },
    );

    const sandbox = initializeSandbox();
    const pyricApp = createAppForSandbox(
      sandbox,
      { apiKey: 'test-key', projectId: 'sandbox', appId: '1:123:web:abc' },
      `pyric-url-parity-${Date.now()}`,
    );
    initializeAppCheck(pyricApp, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId: '1:123:web:abc', projectId: 'sandbox' }, 3600),
      }),
    });
    const upApp = initializeUpstreamApp(
      { apiKey: 'test-key', projectId: 'sandbox', appId: '1:123:web:abc' },
      `up-url-parity-${Date.now()}`,
    );

    try {
      const cases: Array<{
        pyricBackend: Backend;
        upBackend: UpstreamBackend;
        modelName: string;
      }> = [
        {
          pyricBackend: new GoogleAIBackend(),
          upBackend: new UpstreamGoogleAIBackend(),
          modelName: 'gemini-2.5-flash',
        },
        {
          pyricBackend: new AgentPlatformBackend(),
          upBackend: new UpstreamAgentPlatformBackend(),
          modelName: 'gemini-2.5-flash',
        },
        {
          pyricBackend: new AgentPlatformBackend('us-central1'),
          upBackend: new UpstreamAgentPlatformBackend('us-central1'),
          modelName: 'gemini-2.5-flash',
        },
        {
          pyricBackend: new AgentPlatformBackend('europe-west4'),
          upBackend: new UpstreamAgentPlatformBackend('europe-west4'),
          modelName: 'publishers/acme/models/m1',
        },
        {
          pyricBackend: new AgentPlatformBackend('asia-northeast1'),
          upBackend: new UpstreamAgentPlatformBackend('asia-northeast1'),
          modelName: 'tunedModels/custom-7',
        },
      ];

      for (const { pyricBackend, upBackend, modelName } of cases) {
        const pAi = getAI(pyricApp, { backend: pyricBackend });
        script(pAi, [
          {
            respond: {
              error: { code: 404, message: 'model missing', status: 'NOT_FOUND' },
            },
          },
        ]);
        const pModel = getGenerativeModel(pAi, { model: modelName });
        const uModel = getUpstreamGenerativeModel(getUpstreamAI(upApp, { backend: upBackend }), {
          model: modelName,
        });

        expect(pModel.model).toBe(uModel.model);

        let pMsg = '';
        let uMsg = '';
        try {
          await pModel.generateContent('hi');
        } catch (err) {
          pMsg = (err as Error).message;
        }
        try {
          await uModel.generateContent('hi');
        } catch (err) {
          uMsg = (err as Error).message;
        }
        const prefixOf = (msg: string): string => {
          const marker = '] ';
          const idx = msg.indexOf(marker);
          return idx === -1 ? msg : msg.slice(0, idx + 1);
        };
        expect(prefixOf(pMsg)).toBe(prefixOf(uMsg));
        if (modelName === 'gemini-2.5-flash') {
          expect(pMsg).toBe(uMsg);
        }
      }
    } finally {
      globalThis.fetch = origFetch;
      await deleteApp(pyricApp);
      await deleteUpstreamApp(upApp);
      sandbox.dispose();
    }
  });
});
