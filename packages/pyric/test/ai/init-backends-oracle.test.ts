/**
 * Oracle conformance replay for `ai-offline-init-backends-and-model-guards`:
 *   - `ai#getai-app-dispatch` (AI-GETAI-APP-DISPATCH)
 *   - `ai#getai-default-backend` (AI-GETAI-DEFAULT-BACKEND)
 *   - `ai#getai-idempotent` (AI-GETAI-IDEMPOTENT)
 *   - `ai#backend-vertex` (AI-BACKEND-VERTEX)
 *   - `ai#model-name-short` (AI-MODEL-NAME-SHORT)
 *   - `ai#model-name-prefixed` (AI-MODEL-NAME-PREFIXED, documented single-prefix delta)
 *   - `ai#model-name-required` (AI-MODEL-NAME-REQUIRED)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import * as pyricAiNamespace from 'pyric/ai';
import {
  AIError,
  BackendType,
  GoogleAIBackend,
  getAI,
  getGenerativeModel,
  type AgentPlatformBackend,
} from 'pyric/ai';

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
    location?: string;
  };
  idempotency: {
    sameAppDefaultSameHandle: boolean;
    sameAppExplicitGoogleSameHandle: boolean;
    distinctAppsDistinctHandles: boolean;
  };
  vertexRemoved?: {
    hasVertexAIBackend: boolean;
    hasVertexAiEnum: boolean;
    hasHandleLocation: boolean;
  };
  modelNames: {
    googleShortNormalized: string;
    googlePrefixedNormalized: string;
  };
  guards: {
    emptyModelThrow: SyncAiThrowShape;
    missingModelPropThrow: SyncAiThrowShape;
    missingApiKeyThrow: SyncAiThrowShape;
    missingProjectIdThrow: SyncAiThrowShape;
    missingAppIdThrow: SyncAiThrowShape;
  };
}

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'ai',
  'ai-offline-init-backends-and-model-guards.json',
);

function loadInitBackendsObservation(): InitBackendsBehavior {
  const parsed = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as {
    behavior: InitBackendsBehavior;
  };
  return parsed.behavior;
}

function observeSyncAiThrow(fn: () => unknown): SyncAiThrowShape {
  try {
    fn();
    return {
      threw: false,
      isAIError: false,
      isFirebaseError: false,
      code: null,
      name: null,
    };
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
}

describe('oracle replay: ai-offline-init-backends-and-model-guards', () => {
  it('replays default GoogleAIBackend, VertexAIBackend removal, app dispatch, and handle idempotency with zero fetches', async () => {
    const facts = loadInitBackendsObservation();
    expect(facts.fetchCalls).toBe(0);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in init/backends replay');
      },
      { preconnect: originalFetch.preconnect },
    );

    const sandbox = initializeSandbox();
    const primaryApp = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0001',
      },
      'ai-offline-replay-primary',
    );
    const secondaryApp = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0002',
      },
      'ai-offline-replay-secondary',
    );

    try {
      const defaultAi = getAI(primaryApp);
      const repeatDefaultAi = getAI(primaryApp);
      const explicitGoogleAi = getAI(primaryApp, { backend: new GoogleAIBackend() });
      const otherAppAi = getAI(secondaryApp);

      expect({
        carriesApp: defaultAi.app === primaryApp,
        isGoogleAIBackend: defaultAi.backend instanceof GoogleAIBackend,
        backendType: defaultAi.backend.backendType,
        matchesEnumGoogleAi: defaultAi.backend.backendType === BackendType.GOOGLE_AI,
      }).toEqual({
        carriesApp: facts.defaultBackend.carriesApp,
        isGoogleAIBackend: facts.defaultBackend.isGoogleAIBackend,
        backendType: facts.defaultBackend.backendType,
        matchesEnumGoogleAi: facts.defaultBackend.matchesEnumGoogleAi,
      });

      expect({
        sameAppDefaultSameHandle: defaultAi === repeatDefaultAi,
        sameAppExplicitGoogleSameHandle: defaultAi === explicitGoogleAi,
        distinctAppsDistinctHandles: defaultAi !== otherAppAi,
      }).toEqual({
        sameAppDefaultSameHandle: facts.idempotency.sameAppDefaultSameHandle,
        sameAppExplicitGoogleSameHandle: facts.idempotency.sameAppExplicitGoogleSameHandle,
        distinctAppsDistinctHandles: facts.idempotency.distinctAppsDistinctHandles,
      });

      const vertexRemoved = {
        hasVertexAIBackend: 'VertexAIBackend' in pyricAiNamespace,
        hasVertexAiEnum: 'VERTEX_AI' in BackendType,
        hasHandleLocation: 'location' in defaultAi,
      };
      expect(vertexRemoved).toEqual(
        facts.vertexRemoved ?? {
          hasVertexAIBackend: false,
          hasVertexAiEnum: false,
          hasHandleLocation: false,
        },
      );

      expect(fetchCalls).toBe(facts.fetchCalls);
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(primaryApp);
      await deleteApp(secondaryApp);
      sandbox.dispose();
    }
  });

  it('replays GoogleAIBackend and regional model resource normalization and pins single-prefix delta', async () => {
    const facts = loadInitBackendsObservation();
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-vertex',
        appId: '1:100000000000:web:deadbeef0011',
      },
      'ai-offline-replay-models',
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () =>
          mintAppCheckToken(
            { appId: '1:100000000000:web:deadbeef0011', projectId: 'demo-ai-vertex' },
            3600,
          ),
      }),
    });

    try {
      const googleAi = getAI(app);
      const regionalBackend: AgentPlatformBackend = {
        backendType: BackendType.AGENT_PLATFORM,
        location: 'us-central1',
      };
      const regionalAi = getAI(app, { backend: regionalBackend });

      const googleShortModel = getGenerativeModel(googleAi, {
        model: 'gemini-flash-lite-latest',
      });
      const googlePrefixedModel = getGenerativeModel(googleAi, {
        model: 'models/gemini-flash-lite-latest',
      });
      const regionalShortModel = getGenerativeModel(regionalAi, {
        model: 'gemini-flash-lite-latest',
      });
      const regionalPrefixedModel = getGenerativeModel(regionalAi, {
        model: 'models/gemini-flash-lite-latest',
      });

      expect(googleShortModel.model).toBe(facts.modelNames.googleShortNormalized);
      expect(regionalShortModel.model).toBe('publishers/google/models/gemini-flash-lite-latest');
      expect(regionalPrefixedModel.model).toBe('publishers/google/models/gemini-flash-lite-latest');

      // Pinned ai#model-name-prefixed delta vs upstream double-prefixing.
      expect(facts.modelNames.googlePrefixedNormalized).toBe('models/models/gemini-flash-lite-latest');
      expect(googlePrefixedModel.model).toBe('models/gemini-flash-lite-latest');

      // Full-lifecycle propagation: regional model resource executes cleanly against the sandbox broker.
      const regionalReply = await regionalShortModel.generateContent('Ping regional sandbox.');
      expect(regionalReply.response.text().length).toBeGreaterThan(0);
      expect((regionalReply.response as { modelVersion?: string }).modelVersion).toBe(
        'gemini-flash-lite-latest',
      );
      const regionalTokens = await regionalShortModel.countTokens('Ping regional sandbox.');
      expect(regionalTokens.totalTokens).toBeGreaterThan(0);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('replays synchronous no-model and missing-config AIError / FirebaseError guards', async () => {
    const facts = loadInitBackendsObservation();
    const sandbox = initializeSandbox();
    const fullApp = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0021',
      },
      'ai-offline-replay-guards-full',
    );
    const missingApiKeyApp = createAppForSandbox(
      sandbox,
      {
        projectId: 'demo-ai-offline',
        appId: '1:100000000000:web:deadbeef0022',
      },
      'ai-offline-replay-guards-no-apikey',
    );
    const missingProjectIdApp = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        appId: '1:100000000000:web:deadbeef0023',
      },
      'ai-offline-replay-guards-no-project',
    );
    const missingAppIdApp = createAppForSandbox(
      sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-offline',
      },
      'ai-offline-replay-guards-no-appid',
    );

    try {
      const ai = getAI(fullApp);
      const emptyModelThrow = observeSyncAiThrow(() => getGenerativeModel(ai, { model: '' }));
      const missingModelPropThrow = observeSyncAiThrow(() =>
        getGenerativeModel(ai, {} as { model: string }),
      );
      const missingApiKeyThrow = observeSyncAiThrow(() =>
        getGenerativeModel(getAI(missingApiKeyApp), { model: 'gemini-flash-lite-latest' }),
      );
      const missingProjectIdThrow = observeSyncAiThrow(() =>
        getGenerativeModel(getAI(missingProjectIdApp), { model: 'gemini-flash-lite-latest' }),
      );
      const missingAppIdThrow = observeSyncAiThrow(() =>
        getGenerativeModel(getAI(missingAppIdApp), { model: 'gemini-flash-lite-latest' }),
      );

      expect(emptyModelThrow).toEqual(facts.guards.emptyModelThrow);
      expect(missingModelPropThrow).toEqual(facts.guards.missingModelPropThrow);
      expect(missingApiKeyThrow).toEqual(facts.guards.missingApiKeyThrow);
      expect(missingProjectIdThrow).toEqual(facts.guards.missingProjectIdThrow);
      expect(missingAppIdThrow).toEqual(facts.guards.missingAppIdThrow);

      expect(() =>
        getGenerativeModel(getAI(missingApiKeyApp), { model: 'gemini-flash-lite-latest' }),
      ).toThrow(
        'AI: The "apiKey" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid API key. (AI/no-api-key)',
      );
      expect(() =>
        getGenerativeModel(getAI(missingProjectIdApp), { model: 'gemini-flash-lite-latest' }),
      ).toThrow(
        'AI: The "projectId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid project ID. (AI/no-project-id)',
      );
      expect(() =>
        getGenerativeModel(getAI(missingAppIdApp), { model: 'gemini-flash-lite-latest' }),
      ).toThrow(
        'AI: The "appId" field is empty in the local Firebase config. Firebase AI requires this field to contain a valid app ID. (AI/no-app-id)',
      );
    } finally {
      await deleteApp(fullApp);
      await deleteApp(missingApiKeyApp);
      await deleteApp(missingProjectIdApp);
      await deleteApp(missingAppIdApp);
      sandbox.dispose();
    }
  });
});
