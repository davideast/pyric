import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

interface StreamChunkCandidateLike {
  finishReason?: string;
}

interface StreamChunkLike {
  text(): string;
  candidates?: StreamChunkCandidateLike[];
}

interface CountTokensResponseLike {
  totalTokens?: unknown;
}

export interface AppCheckGateModelSubject {
  generateContentStream(prompt: string): Promise<{
    stream: AsyncIterable<StreamChunkLike>;
    response: Promise<StreamChunkLike>;
  }>;
  countTokens(prompt: string): Promise<CountTokensResponseLike>;
}

export interface AppCheckErrorClassifier {
  isAIError(err: unknown): boolean;
  isFirebaseError(err: unknown): boolean;
}

interface RedactedRefusalFacts {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  status: number | null;
  statusText: string | null;
  messageIncludes401Unauthorized: boolean;
  messageIncludesInvalidAppCheckToken: boolean;
}

function classifyRefusalError(
  err: unknown,
  classifier: AppCheckErrorClassifier,
): RedactedRefusalFacts {
  let code: string | null = null;
  let status: number | null = null;
  let statusText: string | null = null;
  let message = '';

  if (err && typeof err === 'object') {
    const record = err as {
      code?: unknown;
      message?: unknown;
      customErrorData?: {
        status?: unknown;
        statusText?: unknown;
      };
    };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.message === 'string') {
      message = record.message;
    }
    if (record.customErrorData && typeof record.customErrorData === 'object') {
      if (typeof record.customErrorData.status === 'number') {
        status = record.customErrorData.status;
      }
      if (typeof record.customErrorData.statusText === 'string') {
        statusText = record.customErrorData.statusText;
      }
    }
  }

  return {
    threw: true,
    isAIError: classifier.isAIError(err),
    isFirebaseError: classifier.isFirebaseError(err),
    code,
    status,
    statusText,
    messageIncludes401Unauthorized: message.includes('[401 Unauthorized]'),
    messageIncludesInvalidAppCheckToken: message.includes('Firebase App Check token is invalid.'),
  };
}

function emptyNoThrowFacts(): RedactedRefusalFacts {
  return {
    threw: false,
    isAIError: false,
    isFirebaseError: false,
    code: null,
    status: null,
    statusText: null,
    messageIncludes401Unauthorized: false,
    messageIncludesInvalidAppCheckToken: false,
  };
}

async function captureUnauthenticatedStream(
  model: AppCheckGateModelSubject,
  classifier: AppCheckErrorClassifier,
): Promise<RedactedRefusalFacts & { chunksYieldedBeforeRejection: number }> {
  let chunksYielded = 0;
  try {
    const result = await model.generateContentStream('Reply with the single word: alpha');
    const responseGuard = result.response.then(
      () => ({ rejected: false as const, err: null as unknown }),
      (err: unknown) => ({ rejected: true as const, err }),
    );
    try {
      for await (const _chunk of result.stream) {
        chunksYielded += 1;
      }
    } catch (streamErr) {
      await responseGuard;
      return {
        ...classifyRefusalError(streamErr, classifier),
        chunksYieldedBeforeRejection: chunksYielded,
      };
    }
    const settled = await responseGuard;
    if (settled.rejected) {
      return {
        ...classifyRefusalError(settled.err, classifier),
        chunksYieldedBeforeRejection: chunksYielded,
      };
    }
    return {
      ...emptyNoThrowFacts(),
      chunksYieldedBeforeRejection: chunksYielded,
    };
  } catch (callErr) {
    return {
      ...classifyRefusalError(callErr, classifier),
      chunksYieldedBeforeRejection: chunksYielded,
    };
  }
}

async function captureUnauthenticatedCountTokens(
  model: AppCheckGateModelSubject,
  classifier: AppCheckErrorClassifier,
): Promise<RedactedRefusalFacts> {
  try {
    await model.countTokens('The quick brown fox jumps over the lazy dog.');
    return emptyNoThrowFacts();
  } catch (err) {
    return classifyRefusalError(err, classifier);
  }
}

export async function observeAppCheckStreamAndCountTokens(options: {
  unauthenticatedModel: AppCheckGateModelSubject;
  authenticatedModel: AppCheckGateModelSubject;
  classifier: AppCheckErrorClassifier;
}): Promise<Record<string, unknown>> {
  const unauthenticatedStream = await captureUnauthenticatedStream(
    options.unauthenticatedModel,
    options.classifier,
  );
  const unauthenticatedCountTokens = await captureUnauthenticatedCountTokens(
    options.unauthenticatedModel,
    options.classifier,
  );

  const authStreamResult = await options.authenticatedModel.generateContentStream(
    'Count from 1 to 10, digits separated by spaces, nothing else.',
  );
  let authChunks = 0;
  for await (const _chunk of authStreamResult.stream) {
    authChunks += 1;
  }
  const authAggregate = await authStreamResult.response;
  const authCandidate = authAggregate.candidates?.[0];
  let authFinishReason: string | null = null;
  if (authCandidate && typeof authCandidate.finishReason === 'string') {
    authFinishReason = authCandidate.finishReason;
  }

  const authCount = await options.authenticatedModel.countTokens(
    'The quick brown fox jumps over the lazy dog.',
  );
  const totalTokensIsPositiveInteger =
    typeof authCount.totalTokens === 'number' &&
    Number.isInteger(authCount.totalTokens) &&
    authCount.totalTokens > 0;

  return {
    model: 'gemini-flash-lite-latest',
    withoutAppCheck: {
      generateContentStream: unauthenticatedStream,
      countTokens: unauthenticatedCountTokens,
      streamAndCountTokensShareCodeAndStatus:
        unauthenticatedStream.threw &&
        unauthenticatedCountTokens.threw &&
        unauthenticatedStream.code === unauthenticatedCountTokens.code &&
        unauthenticatedStream.status === unauthenticatedCountTokens.status,
    },
    withAppCheck: {
      generateContentStream: {
        threw: false,
        chunkCountAtLeastOne: authChunks >= 1,
        finishReason: authFinishReason,
      },
      countTokens: {
        threw: false,
        hasTotalTokensKey: 'totalTokens' in authCount,
        totalTokensIsPositiveInteger,
      },
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
    'Live firebase/ai generateContentStream() and countTokens() App Check enforcement behavior on the GoogleAI backend: verifies that an app without App Check rejects both generateContentStream (before yielding any chunk) and countTokens with the same 401 fetch-error AIError, while an app with an Admin-minted App Check token succeeds on both.',
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
      `sdk-probe-ai-ac-admin-${runSuffix}`,
    );
    const adminAppCheck = adminAppCheckMod.getAppCheck(adminApp);
    const noAppCheckApp = appSdk.initializeApp(
      webConfig,
      `sdk-probe-ai-ac-unauth-${runSuffix}`,
    );
    const withAppCheckApp = appSdk.initializeApp(
      webConfig,
      `sdk-probe-ai-ac-auth-${runSuffix}`,
    );

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
      appCheckSdk.initializeAppCheck(withAppCheckApp, {
        provider,
        isTokenAutoRefreshEnabled: false,
      });

      const unauthenticatedModel = aiSdk.getGenerativeModel(aiSdk.getAI(noAppCheckApp), {
        model: 'gemini-flash-lite-latest',
      });
      const authenticatedModel = aiSdk.getGenerativeModel(aiSdk.getAI(withAppCheckApp), {
        model: 'gemini-flash-lite-latest',
      });

      return await observeAppCheckStreamAndCountTokens({
        unauthenticatedModel,
        authenticatedModel,
        classifier: {
          isAIError: (err) => err instanceof aiSdk.AIError,
          isFirebaseError: (err) => err instanceof appSdk.FirebaseError,
        },
      });
    } finally {
      await appSdk.deleteApp(noAppCheckApp).catch(() => undefined);
      await appSdk.deleteApp(withAppCheckApp).catch(() => undefined);
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      if (hadDebugToken) {
        debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
      } else {
        delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
      }
    }
  },
};
