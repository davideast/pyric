import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

const PROBE_MODEL = 'gemini-flash-lite-latest';
const COUNT_TOKENS_PROMPT = 'The quick brown fox jumps over the lazy dog.';
const GENERATE_PROMPT = 'Reply with the single word: alpha';
const STREAM_PROMPT = 'Count from 1 to 5, digits separated by spaces, nothing else.';

interface DeletedAiProbeCandidateLike {
  finishReason?: unknown;
}

interface DeletedAiProbeResponseLike {
  text(): string;
  candidates?: DeletedAiProbeCandidateLike[];
}

interface DeletedAiProbeCountTokensLike {
  totalTokens?: unknown;
}

export interface DeletedAiProbeModelSubject {
  countTokens(prompt: string): Promise<DeletedAiProbeCountTokensLike>;
  generateContent(prompt: string): Promise<{
    response: DeletedAiProbeResponseLike;
  }>;
  generateContentStream(prompt: string): Promise<{
    stream: AsyncIterable<DeletedAiProbeResponseLike>;
    response: Promise<DeletedAiProbeResponseLike>;
  }>;
}

export interface DeletedAiLifecycleErrorClassifier {
  isAIError(err: unknown): boolean;
  isFirebaseError(err: unknown): boolean;
}

export interface DeletedAiErrorFacts {
  readonly threw: boolean;
  readonly isAIError: boolean;
  readonly isFirebaseError: boolean;
  readonly errorName: string | null;
  readonly code: string | null;
  readonly status: number | null;
  readonly mentionsAppDeleted: boolean;
}

interface DeletedAiCountTokensOutcome extends DeletedAiErrorFacts {
  readonly hasTotalTokensKey: boolean;
  readonly totalTokensIsPositiveInteger: boolean;
}

interface DeletedAiGenerateOutcome extends DeletedAiErrorFacts {
  readonly finishReason: string | null;
  readonly hasNonEmptyText: boolean;
}

interface DeletedAiStreamOutcome extends DeletedAiErrorFacts {
  readonly chunksYielded: number;
  readonly finishReason: string | null;
}

interface DeletedAiFactoryOutcome extends DeletedAiErrorFacts {
  readonly usesTargetApp: boolean;
}

export interface DeletedAppAiLifecycleDriver<AppHandle, AiHandle> {
  readonly hasGlobalIndexedDB: boolean;
  readonly classifier: DeletedAiLifecycleErrorClassifier;
  createApp(role: string): AppHandle;
  deleteApp(app: AppHandle): Promise<void>;
  activateAppCheck(app: AppHandle, warmBeforeUse: boolean): Promise<void>;
  getAI(app: AppHandle): AiHandle;
  aiAppOf(ai: AiHandle): AppHandle | undefined;
  getGenerativeModel(ai: AiHandle): DeletedAiProbeModelSubject;
}

function noErrorFacts(): DeletedAiErrorFacts {
  return {
    threw: false,
    isAIError: false,
    isFirebaseError: false,
    errorName: null,
    code: null,
    status: null,
    mentionsAppDeleted: false,
  };
}

export function classifyDeletedAiError(
  err: unknown,
  classifier: DeletedAiLifecycleErrorClassifier,
): DeletedAiErrorFacts {
  let errorName: string | null = null;
  let code: string | null = null;
  let status: number | null = null;
  let message = '';

  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: unknown } }).constructor;
    if (ctor && typeof ctor.name === 'string' && ctor.name.length > 0) {
      errorName = ctor.name;
    }
    const record = err as {
      code?: unknown;
      message?: unknown;
      customErrorData?: {
        status?: unknown;
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
    }
  }

  const mentionsCode = code === 'app/app-deleted';
  const mentionsInMessage = message.includes('app/app-deleted') || message.includes('already deleted');
  return {
    threw: true,
    isAIError: classifier.isAIError(err),
    isFirebaseError: classifier.isFirebaseError(err),
    errorName,
    code,
    status,
    mentionsAppDeleted: mentionsCode || mentionsInMessage,
  };
}

function observeSyncCall(
  fn: () => unknown,
  classifier: DeletedAiLifecycleErrorClassifier,
): DeletedAiErrorFacts {
  try {
    fn();
    return noErrorFacts();
  } catch (err) {
    return classifyDeletedAiError(err, classifier);
  }
}

async function observeCountTokensCall(
  model: DeletedAiProbeModelSubject,
  classifier: DeletedAiLifecycleErrorClassifier,
): Promise<DeletedAiCountTokensOutcome> {
  try {
    const response = await model.countTokens(COUNT_TOKENS_PROMPT);
    const hasKey = 'totalTokens' in response;
    const isPositiveInt =
      typeof response.totalTokens === 'number' &&
      Number.isInteger(response.totalTokens) &&
      response.totalTokens > 0;
    return {
      ...noErrorFacts(),
      hasTotalTokensKey: hasKey,
      totalTokensIsPositiveInteger: isPositiveInt,
    };
  } catch (err) {
    return {
      ...classifyDeletedAiError(err, classifier),
      hasTotalTokensKey: false,
      totalTokensIsPositiveInteger: false,
    };
  }
}

async function observeGenerateContentCall(
  model: DeletedAiProbeModelSubject,
  classifier: DeletedAiLifecycleErrorClassifier,
): Promise<DeletedAiGenerateOutcome> {
  try {
    const result = await model.generateContent(GENERATE_PROMPT);
    const firstCandidate = result.response.candidates?.[0];
    let finishReason: string | null = null;
    if (firstCandidate && typeof firstCandidate.finishReason === 'string') {
      finishReason = firstCandidate.finishReason;
    }
    const text = result.response.text();
    return {
      ...noErrorFacts(),
      finishReason,
      hasNonEmptyText: typeof text === 'string' && text.trim().length > 0,
    };
  } catch (err) {
    return {
      ...classifyDeletedAiError(err, classifier),
      finishReason: null,
      hasNonEmptyText: false,
    };
  }
}

async function observeGenerateContentStreamCall(
  model: DeletedAiProbeModelSubject,
  classifier: DeletedAiLifecycleErrorClassifier,
): Promise<DeletedAiStreamOutcome> {
  let chunksYielded = 0;
  try {
    const result = await model.generateContentStream(STREAM_PROMPT);
    const responseGuard = result.response.then(
      (aggregate) => ({ rejected: false as const, aggregate, err: null as unknown }),
      (err: unknown) => ({ rejected: true as const, aggregate: null, err }),
    );
    try {
      for await (const _chunk of result.stream) {
        chunksYielded += 1;
      }
    } catch (streamErr) {
      await responseGuard;
      return {
        ...classifyDeletedAiError(streamErr, classifier),
        chunksYielded,
        finishReason: null,
      };
    }
    const settled = await responseGuard;
    if (settled.rejected) {
      return {
        ...classifyDeletedAiError(settled.err, classifier),
        chunksYielded,
        finishReason: null,
      };
    }
    const firstCandidate = settled.aggregate?.candidates?.[0];
    let finishReason: string | null = null;
    if (firstCandidate && typeof firstCandidate.finishReason === 'string') {
      finishReason = firstCandidate.finishReason;
    }
    return {
      ...noErrorFacts(),
      chunksYielded,
      finishReason,
    };
  } catch (callErr) {
    return {
      ...classifyDeletedAiError(callErr, classifier),
      chunksYielded,
      finishReason: null,
    };
  }
}

export async function observeDeletedAppAiModelLifecycle<AppHandle, AiHandle>(
  driver: DeletedAppAiLifecycleDriver<AppHandle, AiHandle>,
): Promise<Record<string, unknown>> {
  const deletedFactoryApp = driver.createApp('deleted-factory');
  const retainedAiApp = driver.createApp('retained-ai');
  const retainedAiBeforeDelete = driver.getAI(retainedAiApp);
  await driver.deleteApp(deletedFactoryApp);
  await driver.deleteApp(retainedAiApp);

  let getAIOnDeletedApp: DeletedAiFactoryOutcome;
  let deletedAppAi: AiHandle | undefined;
  try {
    deletedAppAi = driver.getAI(deletedFactoryApp);
    getAIOnDeletedApp = {
      ...noErrorFacts(),
      usesTargetApp: driver.aiAppOf(deletedAppAi) === deletedFactoryApp,
    };
  } catch (err) {
    getAIOnDeletedApp = {
      ...classifyDeletedAiError(err, driver.classifier),
      usesTargetApp: false,
    };
  }

  let getGenerativeModelOnDeletedAppAI: DeletedAiErrorFacts;
  if (deletedAppAi !== undefined) {
    const resolvedDeletedAi = deletedAppAi;
    getGenerativeModelOnDeletedAppAI = observeSyncCall(
      () => driver.getGenerativeModel(resolvedDeletedAi),
      driver.classifier,
    );
  } else {
    getGenerativeModelOnDeletedAppAI = {
      threw: getAIOnDeletedApp.threw,
      isAIError: getAIOnDeletedApp.isAIError,
      isFirebaseError: getAIOnDeletedApp.isFirebaseError,
      errorName: getAIOnDeletedApp.errorName,
      code: getAIOnDeletedApp.code,
      status: getAIOnDeletedApp.status,
      mentionsAppDeleted: getAIOnDeletedApp.mentionsAppDeleted,
    };
  }

  const getGenerativeModelOnRetainedAI = observeSyncCall(
    () => driver.getGenerativeModel(retainedAiBeforeDelete),
    driver.classifier,
  );

  const warmDeletedOwnerApp = driver.createApp('warm-retained-owner');
  const survivingSiblingApp = driver.createApp('surviving-sibling');
  await driver.activateAppCheck(warmDeletedOwnerApp, true);
  await driver.activateAppCheck(survivingSiblingApp, true);

  const warmDeletedOwnerAi = driver.getAI(warmDeletedOwnerApp);
  const survivingSiblingAi = driver.getAI(survivingSiblingApp);
  const equalConfigAppsDistinct = warmDeletedOwnerApp !== survivingSiblingApp;
  const aiHandlesDistinct = warmDeletedOwnerAi !== survivingSiblingAi;
  const aiHandlesCarryOwnApps =
    driver.aiAppOf(warmDeletedOwnerAi) === warmDeletedOwnerApp &&
    driver.aiAppOf(survivingSiblingAi) === survivingSiblingApp;

  const retainedWarmModel = driver.getGenerativeModel(warmDeletedOwnerAi);
  const survivingSiblingModel = driver.getGenerativeModel(survivingSiblingAi);
  await driver.deleteApp(warmDeletedOwnerApp);

  const retainedWarmCountTokens = await observeCountTokensCall(retainedWarmModel, driver.classifier);
  const retainedWarmGenerateContent = await observeGenerateContentCall(
    retainedWarmModel,
    driver.classifier,
  );
  const retainedWarmStream = await observeGenerateContentStreamCall(
    retainedWarmModel,
    driver.classifier,
  );

  const siblingCountTokens = await observeCountTokensCall(survivingSiblingModel, driver.classifier);
  const siblingGenerateContent = await observeGenerateContentCall(
    survivingSiblingModel,
    driver.classifier,
  );
  const siblingStream = await observeGenerateContentStreamCall(
    survivingSiblingModel,
    driver.classifier,
  );

  const coldDeletedOwnerApp = driver.createApp('cold-retained-owner');
  await driver.activateAppCheck(coldDeletedOwnerApp, false);
  const retainedColdModel = driver.getGenerativeModel(driver.getAI(coldDeletedOwnerApp));
  await driver.deleteApp(coldDeletedOwnerApp);
  const retainedColdCountTokens = await observeCountTokensCall(retainedColdModel, driver.classifier);

  return {
    model: PROBE_MODEL,
    hasGlobalIndexedDB: driver.hasGlobalIndexedDB,
    postDeleteFactories: {
      getAIOnDeletedApp,
      getGenerativeModelOnDeletedAppAI,
      getGenerativeModelOnRetainedAI,
    },
    equalConfigTopology: {
      equalConfigAppsDistinct,
      aiHandlesDistinct,
      aiHandlesCarryOwnApps,
    },
    retainedModelWithWarmAppCheck: {
      countTokens: retainedWarmCountTokens,
      generateContent: retainedWarmGenerateContent,
      generateContentStream: retainedWarmStream,
    },
    retainedModelWithColdAppCheck: {
      countTokens: retainedColdCountTokens,
    },
    survivingEqualConfigSiblingModel: {
      countTokens: siblingCountTokens,
      generateContent: siblingGenerateContent,
      generateContentStream: siblingStream,
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
    'Live firebase/app and firebase/ai deletion lifecycle on equal-config apps with Admin-minted App Check tokens: records post-delete getAI and getGenerativeModel outcomes, retained GenerativeModel operations (countTokens, generateContent, generateContentStream) with warm and cold App Check state after deleteApp, and equal-config sibling GenerativeModel survival.',
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
      `sdk-probe-app-ai-del-admin-${runSuffix}`,
    );
    const adminAppCheck = adminAppCheckMod.getAppCheck(adminApp);
    const createdApps: Array<ReturnType<typeof appSdk.initializeApp>> = [];

    let sharedToken: { token: string; expireTimeMillis: number } | null = null;
    const acquireMintedToken = async (): Promise<{ token: string; expireTimeMillis: number }> => {
      if (sharedToken !== null && sharedToken.expireTimeMillis - Date.now() > 60_000) {
        return sharedToken;
      }
      const minted = await mintWithRetry(adminAppCheck, appId);
      sharedToken = {
        token: minted.token,
        expireTimeMillis: Date.now() + minted.ttlMillis,
      };
      return sharedToken;
    };

    try {
      return await observeDeletedAppAiModelLifecycle({
        hasGlobalIndexedDB: typeof indexedDB !== 'undefined',
        classifier: {
          isAIError: (err) => err instanceof aiSdk.AIError,
          isFirebaseError: (err) => err instanceof appSdk.FirebaseError,
        },
        createApp(role: string) {
          const app = appSdk.initializeApp(
            { ...webConfig },
            `sdk-probe-app-ai-del-${role}-${runSuffix}`,
          );
          createdApps.push(app);
          return app;
        },
        async deleteApp(app) {
          await appSdk.deleteApp(app);
        },
        async activateAppCheck(app, warmBeforeUse) {
          const provider = new appCheckSdk.CustomProvider({
            getToken: () => acquireMintedToken(),
          });
          const appCheck = appCheckSdk.initializeAppCheck(app, {
            provider,
            isTokenAutoRefreshEnabled: false,
          });
          if (warmBeforeUse) {
            await appCheckSdk.getToken(appCheck);
          }
        },
        getAI(app) {
          return aiSdk.getAI(app);
        },
        aiAppOf(ai) {
          return ai.app;
        },
        getGenerativeModel(ai) {
          return aiSdk.getGenerativeModel(ai, { model: PROBE_MODEL });
        },
      });
    } finally {
      for (const app of createdApps) {
        await appSdk.deleteApp(app).catch(() => undefined);
      }
      await adminAppMod.deleteApp(adminApp).catch(() => undefined);
      if (hadDebugToken) {
        debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = previousDebugToken;
      } else {
        delete debugGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
      }
    }
  },
};
