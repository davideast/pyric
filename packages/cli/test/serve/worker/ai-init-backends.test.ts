import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { aiDiagnosticPayloadFor } from '../../../src/serve/ai-diagnostics-relay.js';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-init-backends-and-model-guards.json',
);

interface SyncAiThrowShape {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  name: string | null;
}

interface InitBackendsBehavior {
  fetchCalls: number;
  defaultBackend: {
    carriesApp: boolean;
    isGoogleAIBackend: boolean;
    backendType: string;
    matchesEnumGoogleAi: boolean;
    location: string;
  };
  idempotency: {
    sameAppDefaultSameHandle: boolean;
    sameAppExplicitGoogleSameHandle: boolean;
    sameAppVertexSameHandle: boolean;
    googleAndVertexDistinctOnSameApp: boolean;
    vertexLocationsDistinctOnSameApp: boolean;
    distinctAppsDistinctHandles: boolean;
  };
  vertexBackend: {
    isVertexAIBackend: boolean;
    backendType: string;
    matchesEnumVertexAi: boolean;
    defaultBackendLocation: string;
    defaultHandleLocation: string;
    customBackendLocation: string;
    customHandleLocation: string;
  };
  modelNames: {
    googleShortNormalized: string;
    googlePrefixedNormalized: string;
    vertexShortNormalized: string;
  };
  guards: {
    emptyModelThrow: SyncAiThrowShape;
    missingModelPropThrow: SyncAiThrowShape;
  };
}

function loadInitBackendsObservation(): InitBackendsBehavior {
  const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    behavior: InitBackendsBehavior;
  };
  return parsed.behavior;
}

let appSeq = 0;

describe('served AI entry and SharedWorker init/backend/model-guard parity', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedAi() {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const servedAi = await import('../../../src/serve/entries/ai.js');
    return { ctx, servedAi };
  }

  it('replays ai-offline-init-backends-and-model-guards across served entries/ai', async () => {
    const facts = loadInitBackendsObservation();
    const { ctx, servedAi } = await setupServedAi();
    const {
      AIError,
      BackendType,
      GoogleAIBackend,
      VertexAIBackend,
      getAI,
      getGenerativeModel,
    } = servedAi;

    const primaryApp = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-worker-init',
        appId: '1:123456789012:web:abcdef01',
      },
      `served-ai-init-primary-${++appSeq}`,
    );
    const secondaryApp = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-worker-init',
        appId: '1:123456789012:web:abcdef02',
      },
      `served-ai-init-secondary-${++appSeq}`,
    );

    const observeThrow = (fn: () => unknown): SyncAiThrowShape => {
      try {
        fn();
        return { threw: false, isAIError: false, isFirebaseError: false, code: null, name: null };
      } catch (err) {
        let code: string | null = null;
        let name: string | null = null;
        if (err && typeof err === 'object') {
          const record = err as { code?: unknown; name?: unknown };
          if (typeof record.code === 'string') {
            code = record.code;
          }
          if (typeof record.name === 'string') {
            name = record.name;
          }
        }
        return {
          threw: true,
          isAIError: err instanceof AIError,
          isFirebaseError: err instanceof FirebaseError,
          code,
          name,
        };
      }
    };

    try {
      const defaultAi = getAI(primaryApp);
      const repeatDefaultAi = getAI(primaryApp);
      const explicitGoogleAi = getAI(primaryApp, { backend: new GoogleAIBackend() });
      const otherAppAi = getAI(secondaryApp);

      const vertexDefault = new VertexAIBackend();
      const vertexAiDefault = getAI(primaryApp, { backend: vertexDefault });
      const repeatVertexAiDefault = getAI(primaryApp, { backend: new VertexAIBackend() });
      const vertexEurope = new VertexAIBackend('europe-west1');
      const vertexAiEurope = getAI(primaryApp, { backend: vertexEurope });

      expect({
        carriesApp: defaultAi.app === primaryApp,
        isGoogleAIBackend: defaultAi.backend instanceof GoogleAIBackend,
        backendType: defaultAi.backend.backendType,
        matchesEnumGoogleAi: defaultAi.backend.backendType === BackendType.GOOGLE_AI,
        location: defaultAi.location,
      }).toEqual(facts.defaultBackend);

      expect({
        sameAppDefaultSameHandle: defaultAi === repeatDefaultAi,
        sameAppExplicitGoogleSameHandle: defaultAi === explicitGoogleAi,
        sameAppVertexSameHandle: vertexAiDefault === repeatVertexAiDefault,
        googleAndVertexDistinctOnSameApp: defaultAi !== vertexAiDefault,
        vertexLocationsDistinctOnSameApp: vertexAiDefault !== vertexAiEurope,
        distinctAppsDistinctHandles: defaultAi !== otherAppAi,
      }).toEqual(facts.idempotency);

      expect({
        isVertexAIBackend: vertexDefault instanceof VertexAIBackend,
        backendType: vertexDefault.backendType,
        matchesEnumVertexAi: vertexDefault.backendType === BackendType.VERTEX_AI,
        defaultBackendLocation: vertexDefault.location,
        defaultHandleLocation: vertexAiDefault.location,
        customBackendLocation: vertexEurope.location,
        customHandleLocation: vertexAiEurope.location,
      }).toEqual(facts.vertexBackend);

      const googleShortModel = getGenerativeModel(defaultAi, {
        model: 'gemini-flash-lite-latest',
      });
      const googlePrefixedModel = getGenerativeModel(defaultAi, {
        model: 'models/gemini-flash-lite-latest',
      });
      const vertexShortModel = getGenerativeModel(vertexAiDefault, {
        model: 'gemini-flash-lite-latest',
      });

      expect(googleShortModel.model).toBe(facts.modelNames.googleShortNormalized);
      expect(vertexShortModel.model).toBe(facts.modelNames.vertexShortNormalized);
      expect(facts.modelNames.googlePrefixedNormalized).toBe('models/models/gemini-flash-lite-latest');
      expect(googlePrefixedModel.model).toBe('models/gemini-flash-lite-latest');

      expect(observeThrow(() => getGenerativeModel(defaultAi, { model: '' }))).toEqual(
        facts.guards.emptyModelThrow,
      );
      expect(
        observeThrow(() => getGenerativeModel(defaultAi, {} as { model: string })),
      ).toEqual(facts.guards.missingModelPropThrow);
    } finally {
      await deleteApp(primaryApp);
      await deleteApp(secondaryApp);
      ctx.sandbox.dispose();
    }
  });

  it('transports VertexAIBackend publishers/google/models/<name> across worker host ai.generateContent', async () => {
    const facts = loadInitBackendsObservation();
    const { ctx, servedAi } = await setupServedAi();
    const app = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-worker-vertex',
        appId: '1:123456789012:web:abcdef03',
      },
      `served-ai-vertex-${++appSeq}`,
    );

    try {
      const validClaim = await mintAppCheckToken(
        { appId: '1:123456789012:web:abcdef03', projectId: 'demo-ai-worker-vertex' },
        3600,
      );
      const vertexAi = servedAi.getAI(app, { backend: new servedAi.VertexAIBackend('europe-west1') });
      const vertexModel = servedAi.getGenerativeModel(vertexAi, {
        model: 'gemini-flash-lite-latest',
      });
      expect(vertexModel.model).toBe(facts.modelNames.vertexShortNormalized);

      let resId = '';
      let resOk = false;
      let resValue: unknown = null;
      const hostPort: PortLike & { messages: OutboundMessage[] } = {
        messages: [],
        postMessage(msg: OutboundMessage) {
          this.messages.push(msg);
          if (msg.t === 'res') {
            resId = msg.id;
            resOk = msg.ok;
            if (msg.ok) {
              resValue = msg.value;
            }
          }
        },
      };
      await handleMessage(ctx, hostPort, {
        t: 'op',
        id: 'vertex-worker-op',
        method: 'ai.generateContent',
        model: vertexModel.model,
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Hello Vertex worker.' }] }],
        },
        appCheck: { token: validClaim.token },
        engine: {
          kind: 'scripted',
          script: [{ respond: { text: 'vertex-ok' } }],
        },
      });
      expect(resId).toBe('vertex-worker-op');
      expect(resOk).toBe(true);
      const candidates = (
        resValue as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      ).candidates;
      let firstPartText = '';
      const firstCandidate = candidates?.[0];
      const firstPart = firstCandidate?.content?.parts?.[0];
      if (firstPart && typeof firstPart.text === 'string') {
        firstPartText = firstPart.text;
      }
      expect(firstPartText).toBe('vertex-ok');
      expect((resValue as { modelVersion?: string }).modelVersion).toBe(
        'gemini-flash-lite-latest',
      );
      expect(
        aiDiagnosticPayloadFor({
          kind: 'service_mutation',
          at: 0,
          service: 'ai',
          op: 'model_substituted',
          path: 'publishers/google/models/gemini-flash-lite-latest',
          auth: null,
          detail: {
            requestedModel: 'publishers/google/models/gemini-flash-lite-latest',
            effectiveModel: 'gemini-flash-lite-latest',
          },
        }),
      ).toBeNull();
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });
});
