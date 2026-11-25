import { mintWithRetry } from '../../src/capture/app-check/mint.ts';
import { loadOracleServiceAccount, oracleAppOptions } from '../../src/oracle-credential.ts';
import { resolveProbeWebConfig } from '../../src/sdk-probe-runtime.ts';
import type { Probe } from '../../rigs/types.ts';

type DebugTokenGlobal = {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown;
};

interface StreamChunkLike {
  text(): string;
  functionCalls(): unknown;
  candidates?: Array<{
    index?: number;
    finishReason?: string;
    content?: {
      role?: string;
      parts?: Array<{ type?: string; text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
  inferenceSource?: string;
}

interface StreamResultLike {
  stream: AsyncIterable<StreamChunkLike>;
  response: Promise<StreamChunkLike>;
}

export interface StreamingProbeModelSubject {
  generateContentStream(prompt: string): Promise<StreamResultLike>;
}

function hasCandidatesOrUsage(chunk: StreamChunkLike): boolean {
  const hasCandidates = Array.isArray(chunk.candidates) && chunk.candidates.length > 0;
  const hasUsage = chunk.usageMetadata !== undefined && chunk.usageMetadata !== null;
  return hasCandidates || hasUsage;
}

function hasUsageCounts(chunk: StreamChunkLike): boolean {
  if (!chunk.usageMetadata || typeof chunk.usageMetadata !== 'object') {
    return false;
  }
  return (
    typeof chunk.usageMetadata.promptTokenCount === 'number' &&
    typeof chunk.usageMetadata.totalTokenCount === 'number'
  );
}

function finishReasonOf(chunk: StreamChunkLike | undefined): string | null {
  if (!chunk || !Array.isArray(chunk.candidates) || chunk.candidates.length === 0) {
    return null;
  }
  const firstCandidate = chunk.candidates[0];
  if (!firstCandidate || typeof firstCandidate.finishReason !== 'string') {
    return null;
  }
  return firstCandidate.finishReason;
}

function candidateRoleOf(chunk: StreamChunkLike | undefined): string | null {
  if (!chunk || !Array.isArray(chunk.candidates) || chunk.candidates.length === 0) {
    return null;
  }
  const firstCandidate = chunk.candidates[0];
  if (!firstCandidate || !firstCandidate.content) {
    return null;
  }
  if (typeof firstCandidate.content.role !== 'string') {
    return null;
  }
  return firstCandidate.content.role;
}

export async function observeStreamingChunksAndAggregate(
  model: StreamingProbeModelSubject,
): Promise<Record<string, unknown>> {
  const result = await model.generateContentStream(
    'Count from 1 to 40, digits separated by spaces, nothing else.',
  );
  const iteratorMethod = (result.stream as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  const streamIsAsyncIterable = typeof iteratorMethod === 'function';

  const chunks: StreamChunkLike[] = [];
  const chunkTexts: string[] = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
    chunkTexts.push(chunk.text());
  }

  const aggregate = await result.response;
  const concatenatedChunkText = chunkTexts.join('');
  const aggregateText = aggregate.text();

  const nonFinalChunks = chunks.slice(0, -1);
  const nonFinalChunksOmitFinishReason = nonFinalChunks.every(
    (chunk) => finishReasonOf(chunk) === null,
  );
  const lastChunk = chunks[chunks.length - 1];
  const finalChunkFinishReason = finishReasonOf(lastChunk);

  return {
    model: 'gemini-flash-lite-latest',
    stream: {
      streamIsAsyncIterable,
      chunkCountAtLeastOne: chunks.length >= 1,
      everyChunkHasTextHelper: chunks.every((chunk) => typeof chunk.text === 'function'),
      everyChunkHasFunctionCallsHelper: chunks.every(
        (chunk) => typeof chunk.functionCalls === 'function',
      ),
      everyChunkHasCandidatesOrUsage: chunks.every((chunk) => hasCandidatesOrUsage(chunk)),
      everyChunkHasUsageMetadata: chunks.every((chunk) => hasUsageCounts(chunk)),
      everyChunkCandidateRoleModel: chunks.every((chunk) => candidateRoleOf(chunk) === 'model'),
      nonFinalChunksOmitFinishReason,
      finalChunkFinishReason,
      finishReasonOnlyOnLastChunk:
        chunks.length >= 1 && nonFinalChunksOmitFinishReason && finalChunkFinishReason !== null,
    },
    aggregate: {
      hasTextHelper: typeof aggregate.text === 'function',
      aggregateTextNonEmpty: aggregateText.trim().length > 0,
      aggregateTextMatchesConcatenatedChunks: aggregateText === concatenatedChunkText,
      candidateRole: candidateRoleOf(aggregate),
      finishReason: finishReasonOf(aggregate),
      hasUsageMetadata: aggregate.usageMetadata !== undefined,
      hasModelVersion:
        typeof aggregate.modelVersion === 'string' && aggregate.modelVersion.length > 0,
      hasResponseId: typeof aggregate.responseId === 'string' && aggregate.responseId.length > 0,
      inferenceSource: aggregate.inferenceSource ?? null,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'ai#stream-async-iterable',
  rowIds: [
    'ai#stream-async-iterable',
    'ai#stream-chunk-envelope',
    'ai#stream-finish-last-chunk',
    'ai#stream-usage-every-chunk',
    'ai#stream-response-aggregate',
    'ai#stream-aggregate-final-meta',
  ],
  description:
    'Live firebase/ai generateContentStream() SDK-level chunk iteration and result.response aggregation on the GoogleAI backend with Admin-minted App Check token: verifies async-iterable chunk helpers, candidates/usageMetadata presence on every chunk, finishReason only on the final chunk, concatenated aggregate text parity, and aggregate metadata fields.',
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
      `sdk-probe-ai-stream-admin-${runSuffix}`,
    );
    const adminAppCheck = adminAppCheckMod.getAppCheck(adminApp);
    const clientApp = appSdk.initializeApp(webConfig, `sdk-probe-ai-stream-client-${runSuffix}`);

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

      const model = aiSdk.getGenerativeModel(aiSdk.getAI(clientApp), {
        model: 'gemini-flash-lite-latest',
      });
      return await observeStreamingChunksAndAggregate(model);
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
