import { FirebaseError, deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  AIError,
  BackendType,
  GoogleAIBackend,
  VertexAIBackend,
  getAI,
  getGenerativeModel,
} from 'firebase/ai';
import type { Probe } from '../../rigs/types.ts';

interface SyncAiThrowShape {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  name: string | null;
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

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Pure offline firebase/ai initialization, GoogleAIBackend default vs VertexAIBackend location defaults, getAI handle idempotency, short model name normalization, and synchronous no-model / missing-config AIError guards with zero network calls.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline AI probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    const apps: FirebaseApp[] = [];
    const openApp = (options: Record<string, string>, suffix: string): FirebaseApp => {
      const app = initializeApp(options, `ai-offline-init-${suffix}`);
      apps.push(app);
      return app;
    };

    try {
      const primaryApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-ai-offline',
          appId: '1:100000000000:web:deadbeef0001',
        },
        'primary',
      );
      const secondaryApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-ai-offline',
          appId: '1:100000000000:web:deadbeef0002',
        },
        'secondary',
      );
      const missingApiKeyApp = openApp(
        {
          projectId: 'demo-ai-offline',
          appId: '1:100000000000:web:deadbeef0003',
        },
        'no-key',
      );
      const missingProjectIdApp = openApp(
        {
          apiKey: 'fake-api-key',
          appId: '1:100000000000:web:deadbeef0004',
        },
        'no-project',
      );
      const missingAppIdApp = openApp(
        {
          apiKey: 'fake-api-key',
          projectId: 'demo-ai-offline',
        },
        'no-appid',
      );

      const defaultAi = getAI(primaryApp);
      const repeatDefaultAi = getAI(primaryApp);
      const explicitGoogleAi = getAI(primaryApp, { backend: new GoogleAIBackend() });
      const otherAppAi = getAI(secondaryApp);

      const vertexDefault = new VertexAIBackend();
      const vertexAiDefault = getAI(primaryApp, { backend: vertexDefault });
      const repeatVertexAiDefault = getAI(primaryApp, { backend: new VertexAIBackend() });
      const vertexEurope = new VertexAIBackend('europe-west1');
      const vertexAiEurope = getAI(primaryApp, { backend: vertexEurope });

      const googleShortModel = getGenerativeModel(defaultAi, {
        model: 'gemini-flash-lite-latest',
      });
      const googlePrefixedModel = getGenerativeModel(defaultAi, {
        model: 'models/gemini-flash-lite-latest',
      });
      const vertexShortModel = getGenerativeModel(vertexAiDefault, {
        model: 'gemini-flash-lite-latest',
      });

      const emptyModelThrow = observeSyncAiThrow(() =>
        getGenerativeModel(defaultAi, { model: '' }),
      );
      const missingModelPropThrow = observeSyncAiThrow(() =>
        getGenerativeModel(defaultAi, {} as { model: string }),
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

      return {
        fetchCalls,
        defaultBackend: {
          carriesApp: defaultAi.app === primaryApp,
          isGoogleAIBackend: defaultAi.backend instanceof GoogleAIBackend,
          backendType: defaultAi.backend.backendType,
          matchesEnumGoogleAi: defaultAi.backend.backendType === BackendType.GOOGLE_AI,
          location: defaultAi.location,
        },
        idempotency: {
          sameAppDefaultSameHandle: defaultAi === repeatDefaultAi,
          sameAppExplicitGoogleSameHandle: defaultAi === explicitGoogleAi,
          sameAppVertexSameHandle: vertexAiDefault === repeatVertexAiDefault,
          googleAndVertexDistinctOnSameApp: defaultAi !== vertexAiDefault,
          vertexLocationsDistinctOnSameApp: vertexAiDefault !== vertexAiEurope,
          distinctAppsDistinctHandles: defaultAi !== otherAppAi,
        },
        vertexBackend: {
          isVertexAIBackend: vertexDefault instanceof VertexAIBackend,
          backendType: vertexDefault.backendType,
          matchesEnumVertexAi: vertexDefault.backendType === BackendType.VERTEX_AI,
          defaultBackendLocation: vertexDefault.location,
          defaultHandleLocation: vertexAiDefault.location,
          customBackendLocation: vertexEurope.location,
          customHandleLocation: vertexAiEurope.location,
        },
        modelNames: {
          googleShortNormalized: googleShortModel.model,
          googlePrefixedNormalized: googlePrefixedModel.model,
          vertexShortNormalized: vertexShortModel.model,
        },
        guards: {
          emptyModelThrow,
          missingModelPropThrow,
          missingApiKeyThrow,
          missingProjectIdThrow,
          missingAppIdThrow,
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
      for (const app of apps) {
        await deleteApp(app);
      }
    }
  },
};
