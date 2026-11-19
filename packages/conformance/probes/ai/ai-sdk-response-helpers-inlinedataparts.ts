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

interface MultimodalAttemptRecord {
  backend: string;
  outcome: 'inline-data' | 'no-inline-data' | 'ai-error';
  errorCode: string | null;
  httpStatus: number | null;
}

interface HelperInlineDataPartsShape {
  isArray: boolean;
  hasAtLeastOnePart: boolean;
  firstPartHasInlineDataKey: boolean;
  firstPartHasThoughtSignature: boolean;
  inlineDataKeySet: string[];
  mimeTypeIsImage: boolean;
  dataIsNonEmptyBase64String: boolean;
  wireInlinePartPresent: boolean;
  wireInlineDataKeySet: string[];
  finishReason: string | null;
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
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Live firebase/ai client SDK EnhancedGenerateContentResponse.inlineDataParts() helper shape on plain-text vs multimodal image output with App Check and graceful backend fallback.',
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
          } catch {
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
      `sdk-probe-ai-inline-admin-${runId}`,
    );
    const clientApp = appSdk.initializeApp(
      webConfig as FirebaseOptions,
      `sdk-probe-ai-inline-client-${runId}`,
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

      const plainTextModel = aiSdk.getGenerativeModel(aiSdk.getAI(clientApp), {
        model: 'gemini-flash-lite-latest',
      });
      const plainTextResult = await plainTextModel.generateContent('Reply with one word: ready.');
      const plainTextWire = wireCalls[0];
      if (!plainTextWire || plainTextWire.httpStatus !== 200) {
        throw new Error('plain-text inlineDataParts control probe did not return HTTP 200');
      }
      const plainTextValue = plainTextResult.response.text();
      const plainTextControl = {
        httpStatus: plainTextWire.httpStatus,
        helperTextIsNonEmptyString:
          typeof plainTextValue === 'string' && plainTextValue.length > 0,
        helperInlineDataPartsIsUndefined:
          plainTextResult.response.inlineDataParts() === undefined,
      };

      const candidates = [
        { label: 'google-ai', backend: new aiSdk.GoogleAIBackend() },
        { label: 'vertex-ai-us-central1', backend: new aiSdk.VertexAIBackend('us-central1') },
        { label: 'vertex-ai-global', backend: new aiSdk.VertexAIBackend('global') },
      ];

      const attempts: MultimodalAttemptRecord[] = [];
      let supported = false;
      let backendUsed: string | null = null;
      let outboundResponseModalities: string[] | null = null;
      let helperInlineDataParts: HelperInlineDataPartsShape | null = null;

      for (const candidate of candidates) {
        const callStartIndex = wireCalls.length;
        try {
          const aiInstance = aiSdk.getAI(clientApp, { backend: candidate.backend });
          const imageModel = aiSdk.getGenerativeModel(aiInstance, {
            model: 'gemini-2.5-flash-image',
          });
          const imageResult = await imageModel.generateContent({
            contents: [
              {
                role: 'user',
                parts: [{ text: 'Draw a solid blue square icon on a white background.' }],
              },
            ],
            generationConfig: {
              responseModalities: [aiSdk.ResponseModality.TEXT, aiSdk.ResponseModality.IMAGE],
            },
          });

          let attemptWire: CapturedAiWireCall | undefined;
          if (wireCalls.length > callStartIndex) {
            attemptWire = wireCalls[wireCalls.length - 1];
          }
          let attemptStatus: number | null = null;
          if (attemptWire !== undefined) {
            attemptStatus = attemptWire.httpStatus;
          }

          const parts = imageResult.response.inlineDataParts();
          if (Array.isArray(parts) && parts.length >= 1) {
            const firstPart = parts[0] as unknown as Record<string, unknown> | undefined;
            const firstInlineData = firstPart?.inlineData as
              | { mimeType?: unknown; data?: unknown }
              | undefined;

            const outboundGenConfig = attemptWire?.requestBody.generationConfig as
              | { responseModalities?: unknown }
              | undefined;
            if (Array.isArray(outboundGenConfig?.responseModalities)) {
              outboundResponseModalities = outboundGenConfig.responseModalities.filter(
                (entry): entry is string => typeof entry === 'string',
              );
            }

            const wireCandidates = attemptWire?.responseBody.candidates as
              | Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: unknown }>
              | undefined;
            let wireParts: Array<Record<string, unknown>> = [];
            const rawWireParts = wireCandidates?.[0]?.content?.parts;
            if (Array.isArray(rawWireParts)) {
              wireParts = rawWireParts;
            }
            const wireInlinePart = wireParts.find((part) => 'inlineData' in part);

            let finishReason: string | null = null;
            const rawFinishReason = wireCandidates?.[0]?.finishReason;
            if (typeof rawFinishReason === 'string') {
              finishReason = rawFinishReason;
            }

            supported = true;
            backendUsed = candidate.label;
            helperInlineDataParts = {
              isArray: Array.isArray(parts),
              hasAtLeastOnePart: parts.length >= 1,
              firstPartHasInlineDataKey: firstPart !== undefined && 'inlineData' in firstPart,
              firstPartHasThoughtSignature:
                firstPart !== undefined && 'thoughtSignature' in firstPart,
              inlineDataKeySet: sortedObjectKeys(firstInlineData),
              mimeTypeIsImage:
                typeof firstInlineData?.mimeType === 'string' &&
                firstInlineData.mimeType.startsWith('image/'),
              dataIsNonEmptyBase64String:
                typeof firstInlineData?.data === 'string' && firstInlineData.data.length > 0,
              wireInlinePartPresent: wireInlinePart !== undefined,
              wireInlineDataKeySet: sortedObjectKeys(wireInlinePart?.inlineData),
              finishReason,
            };
            attempts.push({
              backend: candidate.label,
              outcome: 'inline-data',
              errorCode: null,
              httpStatus: attemptStatus,
            });
            break;
          }

          attempts.push({
            backend: candidate.label,
            outcome: 'no-inline-data',
            errorCode: null,
            httpStatus: attemptStatus,
          });
        } catch (err) {
          let attemptStatus: number | null = null;
          if (wireCalls.length > callStartIndex) {
            const failedWire = wireCalls[wireCalls.length - 1];
            if (failedWire !== undefined) {
              attemptStatus = failedWire.httpStatus;
            }
          }

          let errorCode: string | null = null;
          if (err instanceof aiSdk.AIError) {
            errorCode = err.code;
          } else if (err instanceof Error && typeof (err as { code?: unknown }).code === 'string') {
            errorCode = (err as unknown as { code: string }).code;
          } else {
            throw err;
          }

          attempts.push({
            backend: candidate.label,
            outcome: 'ai-error',
            errorCode,
            httpStatus: attemptStatus,
          });
        }
      }

      return {
        plainTextControl,
        multimodalAttempt: {
          supported,
          backendUsed,
          outboundResponseModalities,
          attempts,
        },
        helperInlineDataParts,
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
