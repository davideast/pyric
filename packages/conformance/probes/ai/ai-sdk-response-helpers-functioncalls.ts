import type { FirebaseOptions } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';
import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';

interface CapturedAiWireCall {
  httpStatus: number;
  requestBody: Record<string, unknown>;
  responseBody: Record<string, unknown>;
}

function sortedObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort();
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'ai#helper-functioncalls',
  rowIds: ['ai#helper-functioncalls'],
  description:
    'Live firebase/ai client SDK toolConfig FunctionCallingMode.ANY forced function-call serialization and EnhancedGenerateContentResponse.functionCalls() / inlineDataParts() helper shapes on GoogleAI with App Check.',
  async observe() {
    const [appSdk, appCheckSdk, aiSdk, adminAppMod, { getAppCheck }] = await Promise.all([
      import('firebase/app'),
      import('firebase/app-check'),
      import('firebase/ai'),
      import('firebase-admin/app'),
      import('firebase-admin/app-check'),
    ]);

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const debugGlobal = globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown };
    const hadDebugToken = Object.prototype.hasOwnProperty.call(
      debugGlobal,
      'FIREBASE_APPCHECK_DEBUG_TOKEN',
    );
    const previousDebugToken = debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

    const originalFetch = globalThis.fetch;
    const wireCalls: CapturedAiWireCall[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlString = String(input);
        const response = await originalFetch(input, init);
        if (urlString.includes('firebasevertexai.googleapis.com')) {
          let requestBody: Record<string, unknown> = {};
          if (typeof init?.body === 'string') {
            requestBody = JSON.parse(init.body) as Record<string, unknown>;
          }
          let responseBody: Record<string, unknown> = {};
          try {
            responseBody = (await response.clone().json()) as Record<string, unknown>;
          } catch (err) {
            if (!(err instanceof Error)) {
              throw err;
            }
            responseBody = {};
          }
          wireCalls.push({
            httpStatus: response.status,
            requestBody,
            responseBody,
          });
        }
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );

    const adminApp = adminAppMod.initializeApp(
      oracleAppOptions(sa),
      `sdk-probe-ai-fncall-admin-${runId}`,
    );
    const clientApp = appSdk.initializeApp(
      webConfig as FirebaseOptions,
      `sdk-probe-ai-fncall-client-${runId}`,
    );

    try {
      const appId = webConfig.appId;
      if (!appId) {
        throw new Error('Expected webConfig.appId for AI probe');
      }
      const minted = await mintWithRetry(getAppCheck(adminApp), appId);
      const expireTimeMillis = Date.now() + minted.ttlMillis;
      appCheckSdk.initializeAppCheck(clientApp, {
        provider: new appCheckSdk.CustomProvider({
          getToken: async () => ({
            token: minted.token,
            expireTimeMillis,
          }),
        }),
        isTokenAutoRefreshEnabled: false,
      });

      const model = aiSdk.getGenerativeModel(aiSdk.getAI(clientApp), {
        model: 'gemini-flash-lite-latest',
      });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ type: 'text', text: 'What is the weather in Paris?' }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Look up weather for a city',
                parameters: aiSdk.Schema.object({
                  properties: {
                    city: aiSdk.Schema.string(),
                  },
                }),
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: aiSdk.FunctionCallingMode.ANY,
          },
        },
      });

      const fnWire = wireCalls[0];
      if (!fnWire || fnWire.httpStatus !== 200) {
        throw new Error('functionCalls generateContent probe did not return HTTP 200');
      }

      const calls = result.response.functionCalls();
      const firstCall = calls?.[0];
      const firstArgs = firstCall?.args as Record<string, unknown> | undefined;
      const isPlainArgsObject =
        firstArgs !== undefined && firstArgs !== null && typeof firstArgs === 'object' && !Array.isArray(firstArgs);

      const outboundTools = fnWire.requestBody.tools as
        | Array<{ functionDeclarations?: Array<{ name?: unknown; parameters?: unknown }> }>
        | undefined;
      const firstDecl = outboundTools?.[0]?.functionDeclarations?.[0];
      const outboundToolConfig = fnWire.requestBody.toolConfig as
        | { functionCallingConfig?: { mode?: unknown } }
        | undefined;

      const wireCandidates = fnWire.responseBody.candidates as
        | Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: unknown }>
        | undefined;
      const wireParts = wireCandidates?.[0]?.content?.parts ?? [];
      const wireFnPart = wireParts.find((part) => 'functionCall' in part);

      let helperCallCount = 0;
      if (Array.isArray(calls)) {
        helperCallCount = calls.length;
      }

      return {
        httpStatus: fnWire.httpStatus,
        wireCallCount: wireCalls.length,
        outboundToolRequest: {
          declarationName: firstDecl?.name ?? null,
          parametersJson: firstDecl?.parameters ?? null,
          callingMode: outboundToolConfig?.functionCallingConfig?.mode ?? null,
        },
        wireFunctionCall: {
          present: wireFnPart !== undefined,
          functionCallKeySet: sortedObjectKeys(wireFnPart?.functionCall),
          hasThoughtSignature: wireFnPart !== undefined && 'thoughtSignature' in wireFnPart,
          finishReason: wireCandidates?.[0]?.finishReason ?? null,
        },
        helperFunctionCalls: {
          isArray: Array.isArray(calls),
          count: helperCallCount,
          firstName: firstCall?.name ?? null,
          argsIsPlainObject: isPlainArgsObject,
          argsHasCityString: isPlainArgsObject && typeof firstArgs.city === 'string',
          inlineDataPartsIsUndefined: result.response.inlineDataParts() === undefined,
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
      if (hadDebugToken) {
        debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
      } else {
        delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
      }
      await appSdk.deleteApp(clientApp).catch(() => undefined);
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
    }
  },
};
