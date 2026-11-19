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
import {
  AIError,
  BackendType,
  GoogleAIBackend,
  VertexAIBackend,
  getAI,
  getGenerativeModel,
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
  it('replays default GoogleAIBackend, VertexAIBackend locations, app dispatch, and handle idempotency with zero fetches', async () => {
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

      expect(fetchCalls).toBe(facts.fetchCalls);
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(primaryApp);
      await deleteApp(secondaryApp);
      sandbox.dispose();
    }
  });

  it('replays GoogleAIBackend and VertexAIBackend model resource normalization and pins single-prefix delta', async () => {
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
      const vertexAi = getAI(app, { backend: new VertexAIBackend() });

      const googleShortModel = getGenerativeModel(googleAi, {
        model: 'gemini-flash-lite-latest',
      });
      const googlePrefixedModel = getGenerativeModel(googleAi, {
        model: 'models/gemini-flash-lite-latest',
      });
      const vertexShortModel = getGenerativeModel(vertexAi, {
        model: 'gemini-flash-lite-latest',
      });
      const vertexPrefixedModel = getGenerativeModel(vertexAi, {
        model: 'models/gemini-flash-lite-latest',
      });

      expect(googleShortModel.model).toBe(facts.modelNames.googleShortNormalized);
      expect(vertexShortModel.model).toBe(facts.modelNames.vertexShortNormalized);
      expect(vertexPrefixedModel.model).toBe(facts.modelNames.vertexShortNormalized);

      // Pinned ai#model-name-prefixed delta vs firebase 12.19.0 double-prefixing.
      expect(facts.modelNames.googlePrefixedNormalized).toBe('models/models/gemini-flash-lite-latest');
      expect(googlePrefixedModel.model).toBe('models/gemini-flash-lite-latest');

      // Full-lifecycle propagation: VertexAIBackend model resource executes cleanly against the sandbox broker.
      const vertexReply = await vertexShortModel.generateContent('Ping Vertex sandbox.');
      expect(vertexReply.response.text().length).toBeGreaterThan(0);
      expect((vertexReply.response as { modelVersion?: string }).modelVersion).toBe(
        'gemini-flash-lite-latest',
      );
      const vertexTokens = await vertexShortModel.countTokens('Ping Vertex sandbox.');
      expect(vertexTokens.totalTokens).toBeGreaterThan(0);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('replays synchronous no-model AIError / FirebaseError guards and pins sandbox minimal-app-config tolerance', async () => {
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
    const minimalProjectOnlyApp = createAppForSandbox(
      sandbox,
      { projectId: 'demo-ai-offline' },
      'ai-offline-replay-guards-minimal',
    );

    try {
      const ai = getAI(fullApp);
      const emptyModelThrow = observeSyncAiThrow(() => getGenerativeModel(ai, { model: '' }));
      const missingModelPropThrow = observeSyncAiThrow(() =>
        getGenerativeModel(ai, {} as { model: string }),
      );

      expect(emptyModelThrow).toEqual(facts.guards.emptyModelThrow);
      expect(missingModelPropThrow).toEqual(facts.guards.missingModelPropThrow);

      // Upstream firebase/ai requires apiKey/projectId/appId for cloud REST endpoints;
      // Pyric sandbox apps intentionally accept minimal local configs (e.g. { projectId }).
      expect(facts.guards.missingApiKeyThrow.code).toBe('no-api-key');
      expect(facts.guards.missingProjectIdThrow.code).toBe('no-project-id');
      expect(facts.guards.missingAppIdThrow.code).toBe('no-app-id');
      const minimalModel = getGenerativeModel(getAI(minimalProjectOnlyApp), {
        model: 'gemini-flash-lite-latest',
      });
      expect(minimalModel.model).toBe(facts.modelNames.googleShortNormalized);
    } finally {
      await deleteApp(fullApp);
      await deleteApp(minimalProjectOnlyApp);
      sandbox.dispose();
    }
  });
});
