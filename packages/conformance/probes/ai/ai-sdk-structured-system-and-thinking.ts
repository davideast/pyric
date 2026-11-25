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
  matrixRow: 'ai#generate-structured-output',
  rowIds: [
    'ai#generate-structured-output',
    'ai#generate-system-instruction',
    'ai#generate-thinking-signature',
    'ai#helper-thoughtsummary',
    'ai#schema-rides-request',
  ],
  description:
    'Live firebase/ai client SDK top-level systemInstruction formatting, Schema.object serialization onto generationConfig.responseSchema with JSON structured output, and thinkingConfig thoughtSignature / thoughtSummary() behavior on GoogleAI with App Check.',
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
      `sdk-probe-ai-struct-admin-${runId}`,
    );
    const clientApp = appSdk.initializeApp(
      webConfig as FirebaseOptions,
      `sdk-probe-ai-struct-client-${runId}`,
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

      const sysInstructionText = 'Answer in lowercase.';
      const sysResult = await model.generateContent({
        systemInstruction: sysInstructionText,
        contents: [{ role: 'user', parts: [{ type: 'text', text: 'Say pong.' }] }],
      });
      const sysWire = wireCalls[0];
      if (!sysWire || sysWire.httpStatus !== 200) {
        throw new Error('systemInstruction generateContent probe did not return HTTP 200');
      }

      const wordSchema = aiSdk.Schema.object({
        properties: {
          word: aiSdk.Schema.string(),
        },
      });
      const schemaResult = await model.generateContent({
        contents: [{ role: 'user', parts: [{ type: 'text', text: 'Give one English word for water.' }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: wordSchema,
        },
      });
      const schemaWire = wireCalls[1];
      if (!schemaWire || schemaWire.httpStatus !== 200) {
        throw new Error('responseSchema generateContent probe did not return HTTP 200');
      }

      let parsedSchemaOutput: unknown = null;
      try {
        parsedSchemaOutput = JSON.parse(schemaResult.response.text());
      } catch (err) {
        if (!(err instanceof SyntaxError)) {
          throw err;
        }
        parsedSchemaOutput = null;
      }

      const thinkingResult = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'A basket has 9 apples. You take 2. How many remain?' }],
          },
        ],
        generationConfig: {
          thinkingConfig: { includeThoughts: true },
        },
      });
      const thinkingWire = wireCalls[2];
      if (!thinkingWire || thinkingWire.httpStatus !== 200) {
        throw new Error('thinkingConfig generateContent probe did not return HTTP 200');
      }

      const sysOutbound = sysWire.requestBody.systemInstruction as
        | { role?: unknown; parts?: Array<{ text?: unknown }> }
        | undefined;
      let sysPartsLength = 0;
      if (Array.isArray(sysOutbound?.parts)) {
        sysPartsLength = sysOutbound.parts.length;
      }

      const schemaGenConfig = schemaWire.requestBody.generationConfig as
        | { responseMimeType?: unknown; responseSchema?: unknown }
        | undefined;

      const thinkingWireCandidates = thinkingWire.responseBody.candidates as
        | Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
        | undefined;
      const thinkingWireParts = thinkingWireCandidates?.[0]?.content?.parts ?? [];

      return {
        wireCallCount: wireCalls.length,
        systemInstruction: {
          httpStatus: sysWire.httpStatus,
          outboundRole: sysOutbound?.role ?? null,
          outboundPartsLength: sysPartsLength,
          outboundTextMatchesInput: sysOutbound?.parts?.[0]?.text === sysInstructionText,
          wireTopLevelKeySet: sortedObjectKeys(sysWire.responseBody),
          finishReason: sysResult.response.candidates?.[0]?.finishReason ?? null,
        },
        structuredOutput: {
          httpStatus: schemaWire.httpStatus,
          outboundResponseMimeType: schemaGenConfig?.responseMimeType ?? null,
          outboundResponseSchema: schemaGenConfig?.responseSchema ?? null,
          textParsesAsJson: parsedSchemaOutput !== null,
          parsedKeySet: sortedObjectKeys(parsedSchemaOutput),
          finishReason: schemaResult.response.candidates?.[0]?.finishReason ?? null,
        },
        thinking: {
          httpStatus: thinkingWire.httpStatus,
          anyThoughtPart: thinkingWireParts.some((part) => part.thought === true),
          anyThoughtSignature: thinkingWireParts.some((part) => 'thoughtSignature' in part),
          helperThoughtSummaryIsUndefined: thinkingResult.response.thoughtSummary() === undefined,
          finishReason: thinkingResult.response.candidates?.[0]?.finishReason ?? null,
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
