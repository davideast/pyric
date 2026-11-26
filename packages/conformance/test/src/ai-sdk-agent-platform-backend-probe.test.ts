import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import {
  observeAgentPlatformBackend,
  probe as agentPlatformProbe,
  type AgentPlatformProbeOptions,
} from '../../probes/ai/ai-sdk-agent-platform-backend.ts';

const PROBE_ID = 'ai-sdk-agent-platform-backend';

function createSimulatedVertexFetch(liveFlashStatus: 200 | 403): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const hasAppCheck = Boolean(headers.get('x-firebase-appcheck'));

    if (!hasAppCheck) {
      return new Response(
        JSON.stringify({
          error: {
            code: 401,
            message: 'Firebase App Check token is invalid.',
            status: 'UNAUTHENTICATED',
          },
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (
      liveFlashStatus === 200 &&
      url.pathname.endsWith('/locations/global/publishers/google/models/gemini-2.5-flash:generateContent')
    ) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'pong' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 1,
            totalTokenCount: 6,
          },
          modelVersion: 'gemini-2.5-flash',
          responseId: 'resp-sim-1',
        }),
        {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (liveFlashStatus === 403) {
      return new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Permission denied on resource.',
            status: 'PERMISSION_DENIED',
          },
        }),
        {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 404,
          message: 'Publisher Model was not found.',
          status: 'NOT_FOUND',
        },
      }),
      {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

describe('AI live client SDK AgentPlatformBackend probe (sdk-probes)', () => {
  test('registers staged AgentPlatformBackend sdk-probe with pendingRowLink and web-config requirement', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(agentPlatformProbe.rig).toBe('sdk-probes');
    expect(agentPlatformProbe.requires).toEqual(['web-config']);
    expect(agentPlatformProbe.pendingRowLink).toBe(true);
    expect(agentPlatformProbe.matrixRow).toBe('');
    expect(agentPlatformProbe.rowIds).toEqual([]);
    expect(agentPlatformProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured([PROBE_ID], {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('observes AgentPlatformBackend constructor, keying, normalization, and redacted error URLs across 200 and 403 wire outcomes', async () => {
    const secretProjectId = 'synthetic-project-alpha-99';
    const secretApiKey = 'synthetic-api-key-secret-77';
    const secretAppId = '1:999999999999:web:syntheticapp88';
    const secretAppCheckToken = 'synthetic-appcheck-jwt-token-66';

    const okOptions: AgentPlatformProbeOptions = {
      webConfig: {
        projectId: secretProjectId,
        apiKey: secretApiKey,
        appId: secretAppId,
      },
      mintAppCheckToken: async () => ({
        token: secretAppCheckToken,
        ttlMillis: 3_600_000,
      }),
      fetchImpl: createSimulatedVertexFetch(200),
    };

    const okObserved = await observeAgentPlatformBackend(okOptions);
    const serializedOk = JSON.stringify(okObserved);
    expect(serializedOk).not.toContain(secretProjectId);
    expect(serializedOk).not.toContain(secretApiKey);
    expect(serializedOk).not.toContain(secretAppId);
    expect(serializedOk).not.toContain(secretAppCheckToken);

    expect(okObserved.backendConstructor).toEqual({
      defaultBackend: {
        isBackend: true,
        isAgentPlatformBackend: true,
        isGoogleAIBackend: false,
        backendType: 'AGENT_PLATFORM',
        matchesEnumAgentPlatform: true,
        location: 'global',
      },
      emptyLocationBackend: {
        backendType: 'AGENT_PLATFORM',
        location: 'global',
      },
      regionalBackend: {
        backendType: 'AGENT_PLATFORM',
        location: 'us-central1',
      },
    });

    expect(okObserved.handleKeyingAndGuards).toEqual({
      carriesApp: true,
      handleBackendIsAgentPlatform: true,
      handleBackendLocationGlobal: 'global',
      handleBackendLocationRegional: 'us-central1',
      distinctFromGoogleAiOnSameApp: true,
      omittedAndExplicitGlobalSameHandle: true,
      omittedAndEmptyLocationSameHandle: true,
      distinctLocationsDistinctHandlesOnSameApp: true,
      distinctAppsDistinctHandlesSameLocation: true,
      invalidBackendThrow: {
        threw: true,
        isAIError: true,
        isFirebaseError: true,
        code: 'error',
        name: 'FirebaseError',
        messageIncludesInvalidBackend: true,
      },
      nonAppTargetThrew: true,
    });

    expect(okObserved.modelResourceNormalization).toEqual({
      shortModelOnGlobal: 'publishers/google/models/gemini-2.5-flash',
      modelsPrefixedOnRegional: 'publishers/google/models/gemini-2.5-flash',
      customPublisherPreserved: 'publishers/acme/models/not-a-real-model',
      tunedModelPreserved: 'tunedModels/not-a-real-tuned-model',
    });

    const okWire = okObserved.liveWireAndErrorUrls as Record<string, unknown>;
    expect(okWire.unauthenticatedRegionalUnary).toEqual({
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: false,
      },
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      httpStatus: 401,
      messageMatchesExpectedErrorFetchingPrefix: true,
    });
    expect(okWire.unauthenticatedGlobalStream).toEqual({
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent',
        query: '?alt=sse',
        hasApiKeyHeader: true,
        hasAppCheckHeader: false,
      },
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      httpStatus: 401,
      messageMatchesExpectedErrorFetchingPrefix: true,
      chunksYieldedBeforeRejection: 0,
    });
    expect(okWire.authenticatedUnknownModelGlobal).toEqual({
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/global/publishers/google/models/not-a-real-model:generateContent',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: true,
      },
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      httpStatus: 404,
      messageMatchesExpectedErrorFetchingPrefix: true,
    });
    expect(okWire.authenticatedCustomPublisherCountTokens).toEqual({
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/europe-west4/publishers/acme/models/not-a-real-model:countTokens',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: true,
      },
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      httpStatus: 404,
      messageMatchesExpectedErrorFetchingPrefix: true,
    });
    expect(okWire.authenticatedTunedModelUnary).toEqual({
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/asia-northeast1/tunedModels/not-a-real-tuned-model:generateContent',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: true,
      },
      threw: true,
      isAIError: true,
      isFirebaseError: true,
      code: 'fetch-error',
      httpStatus: 404,
      messageMatchesExpectedErrorFetchingPrefix: true,
    });
    expect(okWire.authenticatedGlobalGenerateContent).toEqual({
      outcome: 'ok',
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: true,
      },
      httpStatus: 200,
      errorCode: null,
      isAIError: false,
      isFirebaseError: false,
      messageMatchesExpectedErrorFetchingPrefix: false,
      finishReason: 'STOP',
      topLevelKeySet: ['candidates', 'modelVersion', 'responseId', 'usageMetadata'],
      helperTextIsNonEmptyString: true,
    });

    const gatedObserved = await observeAgentPlatformBackend({
      ...okOptions,
      fetchImpl: createSimulatedVertexFetch(403),
    });
    const gatedWire = gatedObserved.liveWireAndErrorUrls as Record<string, unknown>;
    expect(gatedWire.authenticatedGlobalGenerateContent).toEqual({
      outcome: 'ai-error',
      wire: {
        host: 'firebasevertexai.googleapis.com',
        pathTemplate:
          '/v1beta/projects/{project}/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
        query: '',
        hasApiKeyHeader: true,
        hasAppCheckHeader: true,
      },
      httpStatus: 403,
      errorCode: 'fetch-error',
      isAIError: true,
      isFirebaseError: true,
      messageMatchesExpectedErrorFetchingPrefix: true,
      finishReason: null,
      topLevelKeySet: [],
      helperTextIsNonEmptyString: false,
    });
  });
});
