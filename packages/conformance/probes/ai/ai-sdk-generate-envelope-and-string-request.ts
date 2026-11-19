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
  matrixRow: 'ai#generate-envelope-keys',
  rowIds: [
    'ai#generate-candidate-keys',
    'ai#generate-envelope-keys',
    'ai#generate-finish-stop',
    'ai#generate-modelversion-responseid',
    'ai#generate-role-model',
    'ai#generate-string-request',
    'ai#generate-usage-key-set',
    'ai#generate-usage-service-tier',
    'ai#helper-text',
  ],
  description:
    'Live firebase/ai client SDK generateContent string-prompt request normalization, raw wire envelope key sets (top-level, candidate, content, usageMetadata.serviceTier, modelVersion, responseId), and EnhancedGenerateContentResponse.text() / inlineDataParts() / functionCalls() helpers on GoogleAI with App Check.',
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
      `sdk-probe-ai-gen-admin-${runId}`,
    );
    const clientApp = appSdk.initializeApp(
      webConfig as FirebaseOptions,
      `sdk-probe-ai-gen-client-${runId}`,
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

      const prompt = 'Reply with one word: pong';
      const model = aiSdk.getGenerativeModel(aiSdk.getAI(clientApp), {
        model: 'gemini-flash-lite-latest',
      });
      const result = await model.generateContent(prompt);

      const firstWire = wireCalls[0];
      if (!firstWire) {
        throw new Error('Expected outbound firebasevertexai.googleapis.com request');
      }
      if (firstWire.httpStatus !== 200) {
        throw new Error(`Expected HTTP 200, got ${firstWire.httpStatus}`);
      }

      const outboundContents = firstWire.requestBody.contents as
        | Array<{ role?: unknown; parts?: Array<{ text?: unknown }> }>
        | undefined;
      const firstOutboundTurn = outboundContents?.[0];
      const firstOutboundPart = firstOutboundTurn?.parts?.[0];

      const wireCandidates = firstWire.responseBody.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      const wireCandidate = wireCandidates?.[0] ?? {};
      const wireContent = (wireCandidate.content as Record<string, unknown> | undefined) ?? {};
      const wireUsage =
        (firstWire.responseBody.usageMetadata as Record<string, unknown> | undefined) ?? {};

      const enhanced = result.response;
      const enhancedCandidate = enhanced.candidates?.[0];
      const enhancedParts = enhancedCandidate?.content?.parts ?? [];
      let concatenatedNonThoughtText = '';
      for (const part of enhancedParts) {
        const record = part as { text?: unknown; thought?: unknown };
        if (typeof record.text === 'string' && !record.thought) {
          concatenatedNonThoughtText += record.text;
        }
      }
      const helperText = enhanced.text();

      let outboundContentsLength = 0;
      if (Array.isArray(outboundContents)) {
        outboundContentsLength = outboundContents.length;
      }
      let outboundFirstRole: string | null = null;
      if (typeof firstOutboundTurn?.role === 'string') {
        outboundFirstRole = firstOutboundTurn.role;
      }
      let outboundFirstPartsLength = 0;
      if (Array.isArray(firstOutboundTurn?.parts)) {
        outboundFirstPartsLength = firstOutboundTurn.parts.length;
      }

      const modelVersionValue = firstWire.responseBody.modelVersion;
      const responseIdValue = firstWire.responseBody.responseId;
      const usageKeySet = sortedObjectKeys(wireUsage);

      return {
        httpStatus: firstWire.httpStatus,
        wireCallCount: wireCalls.length,
        outboundStringPrompt: {
          contentsLength: outboundContentsLength,
          firstRole: outboundFirstRole,
          firstPartsLength: outboundFirstPartsLength,
          firstPartTextMatchesPrompt: firstOutboundPart?.text === prompt,
        },
        wireEnvelope: {
          topLevelKeySet: sortedObjectKeys(firstWire.responseBody),
          candidateKeySet: sortedObjectKeys(wireCandidate),
          candidateHasIndexOnWire: 'index' in wireCandidate,
          candidateWireIndex: wireCandidate.index ?? null,
          contentRole: wireContent.role ?? null,
          contentKeySet: sortedObjectKeys(wireContent),
          finishReason: wireCandidate.finishReason ?? null,
          usageKeySet,
          usageHasPromptTokenCount: usageKeySet.includes('promptTokenCount'),
          usageHasCandidatesTokenCount: usageKeySet.includes('candidatesTokenCount'),
          usageHasPromptTokensDetails: usageKeySet.includes('promptTokensDetails'),
          usageHasTotalTokenCount: usageKeySet.includes('totalTokenCount'),
          usageServiceTierPresent: 'serviceTier' in wireUsage,
          modelVersionNonEmptyString:
            typeof modelVersionValue === 'string' && modelVersionValue.length > 0,
          responseIdNonEmptyString:
            typeof responseIdValue === 'string' && responseIdValue.length > 0,
        },
        enhancedResponse: {
          candidateIndex: enhancedCandidate?.index ?? null,
          finishReason: enhancedCandidate?.finishReason ?? null,
          usageServiceTierPresent:
            enhanced.usageMetadata !== undefined && 'serviceTier' in enhanced.usageMetadata,
          helperTextIsNonEmptyString: typeof helperText === 'string' && helperText.length > 0,
          helperTextMatchesConcatenatedNonThoughtParts: helperText === concatenatedNonThoughtText,
          helperInlineDataPartsIsUndefined: enhanced.inlineDataParts() === undefined,
          helperFunctionCallsIsUndefined: enhanced.functionCalls() === undefined,
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
