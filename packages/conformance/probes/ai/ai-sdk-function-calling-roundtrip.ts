import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

interface FunctionCallValueLike {
  id?: unknown;
  name?: unknown;
  args?: unknown;
}

interface ContentPartLike {
  text?: unknown;
  functionCall?: FunctionCallValueLike;
  functionResponse?: {
    name: string;
    response: object;
  };
  thoughtSignature?: unknown;
}

interface TurnContentLike {
  role: string;
  parts: ContentPartLike[];
}

interface ModelResponseLike {
  text(): string;
  functionCalls(): FunctionCallValueLike[] | undefined;
  candidates?: Array<{
    finishReason?: string;
    content?: TurnContentLike;
  }>;
}

export interface FunctionCallingRoundtripDriver {
  generateForcedFirstTurn(userTurn: TurnContentLike): Promise<{ response: ModelResponseLike }>;
  generateRoundTripSecondTurn(
    contents: TurnContentLike[],
  ): Promise<{ response: ModelResponseLike }>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedKeysOf(value: unknown): string[] {
  if (!isPlainRecord(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

function finishReasonOf(response: ModelResponseLike): string | null {
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    return null;
  }
  const first = response.candidates[0];
  if (!first || typeof first.finishReason !== 'string') {
    return null;
  }
  return first.finishReason;
}

export async function observeFunctionCallingRoundtrip(
  driver: FunctionCallingRoundtripDriver,
): Promise<Record<string, unknown>> {
  const userTurn: TurnContentLike = {
    role: 'user',
    parts: [{ text: 'What is the weather in Paris?' }],
  };

  const firstResult = await driver.generateForcedFirstTurn(userTurn);
  const firstResponse = firstResult.response;
  const firstCandidate = firstResponse.candidates?.[0];
  const modelTurn = firstCandidate?.content;
  if (!modelTurn || !Array.isArray(modelTurn.parts)) {
    throw new Error('First turn response missing candidate content parts');
  }

  const fcPart = modelTurn.parts.find((part) => part.functionCall !== undefined);
  const fcValue = fcPart?.functionCall;
  const helperCalls = firstResponse.functionCalls();
  let helperCallCount = 0;
  if (Array.isArray(helperCalls)) {
    helperCallCount = helperCalls.length;
  }

  const modelPartHasThoughtSignature = modelTurn.parts.some(
    (part) => typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0,
  );

  const functionResponseTurn: TurnContentLike = {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'get_weather',
          response: { temperature: '22C', sky: 'clear' },
        },
      },
    ],
  };

  const secondResult = await driver.generateRoundTripSecondTurn([
    userTurn,
    modelTurn,
    functionResponseTurn,
  ]);
  const secondResponse = secondResult.response;
  const secondCandidate = secondResponse.candidates?.[0];
  const secondContent = secondCandidate?.content;
  let secondParts: ContentPartLike[] = [];
  if (secondContent && Array.isArray(secondContent.parts)) {
    secondParts = secondContent.parts;
  }

  let secondRole: string | null = null;
  if (secondContent && typeof secondContent.role === 'string') {
    secondRole = secondContent.role;
  }

  let fcName: string | null = null;
  if (fcValue && typeof fcValue.name === 'string') {
    fcName = fcValue.name;
  }

  return {
    model: 'gemini-flash-lite-latest',
    firstTurnForcedAny: {
      finishReason: finishReasonOf(firstResponse),
      functionCallPartPresent: fcValue !== undefined,
      functionCallKeySet: sortedKeysOf(fcValue),
      functionCallIdIsNonEmptyString:
        fcValue !== undefined && typeof fcValue.id === 'string' && fcValue.id.length > 0,
      functionCallName: fcName,
      argsIsPlainObject: fcValue !== undefined && isPlainRecord(fcValue.args),
      argsKeySet: sortedKeysOf(fcValue?.args),
      functionCallsHelperCount: helperCallCount,
      modelPartHasThoughtSignature,
    },
    secondTurnRoundTrip: {
      threadedModelTurnPreservedThoughtSignature: modelPartHasThoughtSignature,
      functionResponseRoleUsed: 'user',
      finishReason: finishReasonOf(secondResponse),
      candidateRole: secondRole,
      answerHasTextPart: secondParts.some(
        (part) => typeof part.text === 'string' && part.text.trim().length > 0,
      ),
      answerTextHelperNonEmpty: secondResponse.text().trim().length > 0,
      answerHasFunctionCallPart: secondParts.some((part) => part.functionCall !== undefined),
      functionCallsHelperUndefined: secondResponse.functionCalls() === undefined,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Live firebase/ai function-calling round trip on the GoogleAI backend with Admin-minted App Check token: forces a functionCall on turn 1 via FunctionCallingMode.ANY (verifying id, name, parsed object args, finishReason STOP, and thoughtSignature), then threads the model turn verbatim with a role user functionResponse on turn 2 under default AUTO mode.',
  async observe() {
    const [appSdk, appCheckSdk, aiSdk, adminAppMod, adminAppCheckMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/app-check'),
      import('firebase/ai'),
      import('firebase-admin/app'),
      import('firebase-admin/app-check'),
    ]);

    const debugGlobal = globalThis as DebugTokenGlobal;
    const hadDebugToken = Object.prototype.hasOwnProperty.call(
      debugGlobal,
      'FIREBASE_APPCHECK_DEBUG_TOKEN',
    );
    const previousDebugToken = debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
    delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;

    const sa = await loadOracleServiceAccount();
    const webConfig = await resolveProbeWebConfig(sa);
    const appId = webConfig.appId;
    if (!appId) {
      throw new Error('Oracle webConfig missing appId');
    }
    const runSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const adminApp = adminAppMod.initializeApp(
      oracleAppOptions(sa),
      `sdk-probe-ai-fncall-admin-${runSuffix}`,
    );
    const adminAppCheck = adminAppCheckMod.getAppCheck(adminApp);
    const clientApp = appSdk.initializeApp(webConfig, `sdk-probe-ai-fncall-client-${runSuffix}`);

    try {
      const provider = new appCheckSdk.CustomProvider({
        getToken: async () => {
          const minted = await mintWithRetry(adminAppCheck, appId);
          return {
            token: minted.token,
            expireTimeMillis: Date.now() + minted.ttlMillis,
          };
        },
      });
      appCheckSdk.initializeAppCheck(clientApp, {
        provider,
        isTokenAutoRefreshEnabled: false,
      });

      const weatherTools = [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get current weather for a city',
              parameters: aiSdk.Schema.object({
                properties: {
                  city: aiSdk.Schema.string({ description: 'City name' }),
                },
              }),
            },
          ],
        },
      ];

      const ai = aiSdk.getAI(clientApp);
      const forcedModel = aiSdk.getGenerativeModel(ai, {
        model: 'gemini-flash-lite-latest',
        tools: weatherTools,
        toolConfig: {
          functionCallingConfig: {
            mode: aiSdk.FunctionCallingMode.ANY,
          },
        },
      });
      const roundTripModel = aiSdk.getGenerativeModel(ai, {
        model: 'gemini-flash-lite-latest',
        tools: weatherTools,
      });

      type GenerateRequestArg = Parameters<typeof forcedModel.generateContent>[0];

      return await observeFunctionCallingRoundtrip({
        generateForcedFirstTurn: (userTurn) =>
          forcedModel.generateContent({
            contents: [userTurn],
          } as unknown as GenerateRequestArg),
        generateRoundTripSecondTurn: (contents) =>
          roundTripModel.generateContent({
            contents,
          } as unknown as GenerateRequestArg),
      });
    } finally {
      await appSdk.deleteApp(clientApp).catch(() => undefined);
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      if (hadDebugToken) {
        debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
      } else {
        delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
      }
    }
  },
};
