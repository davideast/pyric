import type { Backend } from 'firebase/ai';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';

export interface AgentPlatformProbeOptions {
  webConfig: FirebaseOptions & { projectId: string; appId: string; apiKey: string };
  mintAppCheckToken: () => Promise<{ token: string; ttlMillis: number }>;
  fetchImpl?: typeof fetch;
}

interface SyncThrowFacts {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  name: string | null;
  messageIncludesInvalidBackend: boolean;
}

interface CapturedWireRequest {
  host: string;
  fullUrl: string;
  pathTemplate: string;
  query: string;
  hasApiKeyHeader: boolean;
  hasAppCheckHeader: boolean;
  httpStatus: number;
  responseBody: Record<string, unknown>;
}

interface WireRequestSummary {
  host: string;
  pathTemplate: string;
  query: string;
  hasApiKeyHeader: boolean;
  hasAppCheckHeader: boolean;
}

interface LiveErrorCallFacts {
  wire: WireRequestSummary;
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  httpStatus: number | null;
  messageMatchesExpectedErrorFetchingPrefix: boolean;
}

function sortedObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort();
}

function normalizePathTemplate(pathname: string, projectId: string): string {
  const marker = `/projects/${projectId}/`;
  if (!pathname.includes(marker)) {
    return pathname;
  }
  return pathname.split(marker).join('/projects/{project}/');
}

function toWireSummary(entry: CapturedWireRequest): WireRequestSummary {
  return {
    host: entry.host,
    pathTemplate: entry.pathTemplate,
    query: entry.query,
    hasApiKeyHeader: entry.hasApiKeyHeader,
    hasAppCheckHeader: entry.hasAppCheckHeader,
  };
}

function observeSyncThrow(
  fn: () => unknown,
  isAIError: (err: unknown) => boolean,
  isFirebaseError: (err: unknown) => boolean,
): SyncThrowFacts {
  try {
    fn();
    return {
      threw: false,
      isAIError: false,
      isFirebaseError: false,
      code: null,
      name: null,
      messageIncludesInvalidBackend: false,
    };
  } catch (err) {
    let code: string | null = null;
    let name: string | null = null;
    let message = '';
    if (err && typeof err === 'object') {
      const record = err as { code?: unknown; name?: unknown; message?: unknown };
      if (typeof record.code === 'string') {
        code = record.code;
      }
      if (typeof record.name === 'string') {
        name = record.name;
      }
      if (typeof record.message === 'string') {
        message = record.message;
      }
    }
    return {
      threw: true,
      isAIError: isAIError(err),
      isFirebaseError: isFirebaseError(err),
      code,
      name,
      messageIncludesInvalidBackend: message.includes('Invalid backend: "VERTEX_AI"'),
    };
  }
}

function classifyLiveError(
  err: unknown,
  wire: CapturedWireRequest,
  isAIError: (value: unknown) => boolean,
  isFirebaseError: (value: unknown) => boolean,
): LiveErrorCallFacts {
  let code: string | null = null;
  let httpStatus: number | null = wire.httpStatus;
  let message = '';

  if (err && typeof err === 'object') {
    const record = err as {
      code?: unknown;
      message?: unknown;
      customErrorData?: { status?: unknown };
    };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.message === 'string') {
      message = record.message;
    }
    if (record.customErrorData && typeof record.customErrorData.status === 'number') {
      httpStatus = record.customErrorData.status;
    }
  }

  let expectedPrefix = `AI: Error fetching from ${wire.fullUrl}: [`;
  if (httpStatus !== null) {
    expectedPrefix = `AI: Error fetching from ${wire.fullUrl}: [${httpStatus}`;
  }

  return {
    wire: toWireSummary(wire),
    threw: true,
    isAIError: isAIError(err),
    isFirebaseError: isFirebaseError(err),
    code,
    httpStatus,
    messageMatchesExpectedErrorFetchingPrefix: message.startsWith(expectedPrefix),
  };
}

export async function observeAgentPlatformBackend(
  options: AgentPlatformProbeOptions,
): Promise<Record<string, unknown>> {
  const [appSdk, appCheckSdk, aiSdk] = await Promise.all([
    import('firebase/app'),
    import('firebase/app-check'),
    import('firebase/ai'),
  ]);

  const { webConfig } = options;
  const projectId = webConfig.projectId;
  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const debugGlobal = globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown };
  const hadDebugToken = Object.prototype.hasOwnProperty.call(
    debugGlobal,
    'FIREBASE_APPCHECK_DEBUG_TOKEN',
  );
  const previousDebugToken = debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
  delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

  const originalFetch = globalThis.fetch;
  const baseFetch = options.fetchImpl ?? originalFetch;
  const wireCalls: CapturedWireRequest[] = [];

  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const fullUrl = String(input);
      const parsedUrl = new URL(fullUrl);
      const headers = new Headers(init?.headers);
      const response = await baseFetch(input, init);
      if (parsedUrl.host === 'firebasevertexai.googleapis.com') {
        let responseBody: Record<string, unknown> = {};
        try {
          responseBody = (await response.clone().json()) as Record<string, unknown>;
        } catch {
          responseBody = {};
        }
        wireCalls.push({
          host: parsedUrl.host,
          fullUrl,
          pathTemplate: normalizePathTemplate(parsedUrl.pathname, projectId),
          query: parsedUrl.search,
          hasApiKeyHeader: Boolean(headers.get('x-goog-api-key')),
          hasAppCheckHeader: Boolean(headers.get('x-firebase-appcheck')),
          httpStatus: response.status,
          responseBody,
        });
      }
      return response;
    },
    { preconnect: originalFetch.preconnect },
  );

  const authApp = appSdk.initializeApp(webConfig, `sdk-probe-ai-ap-auth-${runId}`);
  const unauthApp = appSdk.initializeApp(webConfig, `sdk-probe-ai-ap-unauth-${runId}`);

  const isAIError = (err: unknown): boolean => err instanceof aiSdk.AIError;
  const isFirebaseError = (err: unknown): boolean => err instanceof appSdk.FirebaseError;

  const takeLatestWire = (beforeCount: number, label: string): CapturedWireRequest => {
    const latest = wireCalls[wireCalls.length - 1];
    if (wireCalls.length <= beforeCount || latest === undefined) {
      throw new Error(`Expected outbound firebasevertexai.googleapis.com call for ${label}`);
    }
    return latest;
  };

  const captureErrorCall = async (
    label: string,
    invoke: () => Promise<unknown>,
  ): Promise<LiveErrorCallFacts> => {
    const beforeCount = wireCalls.length;
    try {
      await invoke();
    } catch (err) {
      const wire = takeLatestWire(beforeCount, label);
      return classifyLiveError(err, wire, isAIError, isFirebaseError);
    }
    const wire = takeLatestWire(beforeCount, label);
    return {
      wire: toWireSummary(wire),
      threw: false,
      isAIError: false,
      isFirebaseError: false,
      code: null,
      httpStatus: wire.httpStatus,
      messageMatchesExpectedErrorFetchingPrefix: false,
    };
  };

  try {
    const minted = await options.mintAppCheckToken();
    const expireTimeMillis = Date.now() + minted.ttlMillis;
    appCheckSdk.initializeAppCheck(authApp, {
      provider: new appCheckSdk.CustomProvider({
        getToken: async () => ({
          token: minted.token,
          expireTimeMillis,
        }),
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const defaultBackend = new aiSdk.AgentPlatformBackend();
    const emptyLocationBackend = new aiSdk.AgentPlatformBackend('');
    const regionalBackend = new aiSdk.AgentPlatformBackend('us-central1');

    const googleAi = aiSdk.getAI(authApp, { backend: new aiSdk.GoogleAIBackend() });
    const globalDefaultAi = aiSdk.getAI(authApp, { backend: new aiSdk.AgentPlatformBackend() });
    const globalExplicitAi = aiSdk.getAI(authApp, {
      backend: new aiSdk.AgentPlatformBackend('global'),
    });
    const globalEmptyAi = aiSdk.getAI(authApp, { backend: new aiSdk.AgentPlatformBackend('') });
    const regionalAi = aiSdk.getAI(authApp, {
      backend: new aiSdk.AgentPlatformBackend('us-central1'),
    });
    const europeAi = aiSdk.getAI(authApp, {
      backend: new aiSdk.AgentPlatformBackend('europe-west4'),
    });
    const asiaAi = aiSdk.getAI(authApp, {
      backend: new aiSdk.AgentPlatformBackend('asia-northeast1'),
    });

    const unauthGlobalAi = aiSdk.getAI(unauthApp, { backend: new aiSdk.AgentPlatformBackend() });
    const unauthRegionalAi = aiSdk.getAI(unauthApp, {
      backend: new aiSdk.AgentPlatformBackend('us-central1'),
    });

    const invalidBackendThrow = observeSyncThrow(
      () =>
        aiSdk.getAI(authApp, {
          backend: { backendType: 'VERTEX_AI' } as unknown as Backend,
        }),
      isAIError,
      isFirebaseError,
    );

    let nonAppTargetThrew = false;
    try {
      aiSdk.getAI({} as FirebaseApp);
    } catch {
      nonAppTargetThrew = true;
    }

    const shortModelOnGlobal = aiSdk.getGenerativeModel(globalDefaultAi, {
      model: 'gemini-2.5-flash',
    });
    const modelsPrefixedOnRegional = aiSdk.getGenerativeModel(regionalAi, {
      model: 'models/gemini-2.5-flash',
    });
    const customPublisherModel = aiSdk.getGenerativeModel(europeAi, {
      model: 'publishers/acme/models/not-a-real-model',
    });
    const tunedModel = aiSdk.getGenerativeModel(asiaAi, {
      model: 'tunedModels/not-a-real-tuned-model',
    });

    const unauthRegionalModel = aiSdk.getGenerativeModel(unauthRegionalAi, {
      model: 'gemini-2.5-flash',
    });
    const unauthenticatedRegionalUnary = await captureErrorCall(
      'unauthenticatedRegionalUnary',
      () => unauthRegionalModel.generateContent('Reply with one word: pong'),
    );

    const unauthGlobalModel = aiSdk.getGenerativeModel(unauthGlobalAi, {
      model: 'gemini-2.5-flash',
    });
    let streamChunksBeforeRejection = 0;
    const unauthenticatedGlobalStreamCore = await captureErrorCall(
      'unauthenticatedGlobalStream',
      async () => {
        const streamResult = await unauthGlobalModel.generateContentStream(
          'Reply with one word: pong',
        );
        const settledResponse = streamResult.response.then(
          () => ({ rejected: false as const, error: null as unknown }),
          (err: unknown) => ({ rejected: true as const, error: err }),
        );
        for await (const _chunk of streamResult.stream) {
          streamChunksBeforeRejection += 1;
        }
        const finalState = await settledResponse;
        if (finalState.rejected) {
          throw finalState.error;
        }
      },
    );

    const globalUnknownModel = aiSdk.getGenerativeModel(globalDefaultAi, {
      model: 'not-a-real-model',
    });
    const authenticatedUnknownModelGlobal = await captureErrorCall(
      'authenticatedUnknownModelGlobal',
      () => globalUnknownModel.generateContent('Reply with one word: pong'),
    );

    const authenticatedCustomPublisherCountTokens = await captureErrorCall(
      'authenticatedCustomPublisherCountTokens',
      () => customPublisherModel.countTokens('Reply with one word: pong'),
    );

    const authenticatedTunedModelUnary = await captureErrorCall(
      'authenticatedTunedModelUnary',
      () => tunedModel.generateContent('Reply with one word: pong'),
    );

    const liveCallBefore = wireCalls.length;
    let authenticatedGlobalGenerateContent: Record<string, unknown>;
    try {
      const liveResult = await shortModelOnGlobal.generateContent('Reply with one word: pong');
      const liveWire = takeLatestWire(liveCallBefore, 'authenticatedGlobalGenerateContent');
      const firstCandidate = liveResult.response.candidates?.[0];
      let finishReason: string | null = null;
      if (firstCandidate && typeof firstCandidate.finishReason === 'string') {
        finishReason = firstCandidate.finishReason;
      }
      const helperText = liveResult.response.text();
      authenticatedGlobalGenerateContent = {
        outcome: 'ok',
        wire: toWireSummary(liveWire),
        httpStatus: liveWire.httpStatus,
        errorCode: null,
        isAIError: false,
        isFirebaseError: false,
        messageMatchesExpectedErrorFetchingPrefix: false,
        finishReason,
        topLevelKeySet: sortedObjectKeys(liveWire.responseBody),
        helperTextIsNonEmptyString: typeof helperText === 'string' && helperText.length > 0,
      };
    } catch (err) {
      const liveWire = takeLatestWire(liveCallBefore, 'authenticatedGlobalGenerateContent');
      const classified = classifyLiveError(err, liveWire, isAIError, isFirebaseError);
      authenticatedGlobalGenerateContent = {
        outcome: 'ai-error',
        wire: classified.wire,
        httpStatus: classified.httpStatus,
        errorCode: classified.code,
        isAIError: classified.isAIError,
        isFirebaseError: classified.isFirebaseError,
        messageMatchesExpectedErrorFetchingPrefix:
          classified.messageMatchesExpectedErrorFetchingPrefix,
        finishReason: null,
        topLevelKeySet: [],
        helperTextIsNonEmptyString: false,
      };
    }

    return {
      backendConstructor: {
        defaultBackend: {
          isBackend: defaultBackend instanceof aiSdk.Backend,
          isAgentPlatformBackend: defaultBackend instanceof aiSdk.AgentPlatformBackend,
          isGoogleAIBackend: defaultBackend instanceof aiSdk.GoogleAIBackend,
          backendType: defaultBackend.backendType,
          matchesEnumAgentPlatform:
            defaultBackend.backendType === aiSdk.BackendType.AGENT_PLATFORM,
          location: defaultBackend.location,
        },
        emptyLocationBackend: {
          backendType: emptyLocationBackend.backendType,
          location: emptyLocationBackend.location,
        },
        regionalBackend: {
          backendType: regionalBackend.backendType,
          location: regionalBackend.location,
        },
      },
      handleKeyingAndGuards: {
        carriesApp: globalDefaultAi.app === authApp,
        handleBackendIsAgentPlatform:
          globalDefaultAi.backend instanceof aiSdk.AgentPlatformBackend,
        handleBackendLocationGlobal: (
          globalDefaultAi.backend as InstanceType<typeof aiSdk.AgentPlatformBackend>
        ).location,
        handleBackendLocationRegional: (
          regionalAi.backend as InstanceType<typeof aiSdk.AgentPlatformBackend>
        ).location,
        distinctFromGoogleAiOnSameApp: globalDefaultAi !== googleAi,
        omittedAndExplicitGlobalSameHandle: globalDefaultAi === globalExplicitAi,
        omittedAndEmptyLocationSameHandle: globalDefaultAi === globalEmptyAi,
        distinctLocationsDistinctHandlesOnSameApp: globalDefaultAi !== regionalAi,
        distinctAppsDistinctHandlesSameLocation: globalDefaultAi !== unauthGlobalAi,
        invalidBackendThrow,
        nonAppTargetThrew,
      },
      modelResourceNormalization: {
        shortModelOnGlobal: shortModelOnGlobal.model,
        modelsPrefixedOnRegional: modelsPrefixedOnRegional.model,
        customPublisherPreserved: customPublisherModel.model,
        tunedModelPreserved: tunedModel.model,
      },
      liveWireAndErrorUrls: {
        unauthenticatedRegionalUnary,
        unauthenticatedGlobalStream: {
          ...unauthenticatedGlobalStreamCore,
          chunksYieldedBeforeRejection: streamChunksBeforeRejection,
        },
        authenticatedUnknownModelGlobal,
        authenticatedCustomPublisherCountTokens,
        authenticatedTunedModelUnary,
        authenticatedGlobalGenerateContent,
      },
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (hadDebugToken) {
      debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
    } else {
      delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    }
    await appSdk.deleteApp(authApp).catch(() => undefined);
    await appSdk.deleteApp(unauthApp).catch(() => undefined);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Live firebase/ai AgentPlatformBackend(location?) constructor defaults, BackendType.AGENT_PLATFORM handle keying per (FirebaseApp, location), invalid backend error guard, model resource normalization (short, models/-prefixed, custom publisher, tunedModels), and firebasevertexai.googleapis.com locations/<location>/... request URL and fetch-error decoration.',
  async observe() {
    const [adminAppMod, { getAppCheck }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/app-check'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const appId = webConfig.appId;
    const apiKey = webConfig.apiKey;
    const projectId = webConfig.projectId;
    if (!appId || !apiKey || !projectId) {
      throw new Error('Expected webConfig with projectId, appId, and apiKey for AI probe');
    }

    const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const adminApp = adminAppMod.initializeApp(
      oracleAppOptions(sa),
      `sdk-probe-ai-ap-admin-${runId}`,
    );

    try {
      const adminAppCheck = getAppCheck(adminApp);
      return await observeAgentPlatformBackend({
        webConfig: {
          ...webConfig,
          projectId,
          appId,
          apiKey,
        },
        mintAppCheckToken: () => mintWithRetry(adminAppCheck, appId),
      });
    } finally {
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
    }
  },
};
