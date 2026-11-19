import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'conformance', 'observations', 'ai');

function readObservation<T>(name: string): T {
  const raw = readFileSync(join(OBS_DIR, `${name}.json`), 'utf8');
  const parsed = JSON.parse(raw) as { behavior: T };
  return parsed.behavior;
}

interface StreamingBehavior {
  model: string;
  stream: {
    streamIsAsyncIterable: boolean;
    chunkCountAtLeastOne: boolean;
    everyChunkHasTextHelper: boolean;
    everyChunkHasFunctionCallsHelper: boolean;
    everyChunkHasCandidatesOrUsage: boolean;
    everyChunkHasUsageMetadata: boolean;
    everyChunkCandidateRoleModel: boolean;
    nonFinalChunksOmitFinishReason: boolean;
    finalChunkFinishReason: string | null;
    finishReasonOnlyOnLastChunk: boolean;
  };
  aggregate: {
    hasTextHelper: boolean;
    aggregateTextNonEmpty: boolean;
    aggregateTextMatchesConcatenatedChunks: boolean;
    candidateRole: string | null;
    finishReason: string | null;
  };
}

interface ChatSessionBehavior {
  model: string;
  sendMessage: {
    candidateRole: string | null;
    finishReason: string | null;
    textHelperNonEmpty: boolean;
    historyLengthAfterSend: number;
    historyRolesAfterSend: string[];
  };
  sendMessageStream: {
    hasAsyncIterableStream: boolean;
    hasResponsePromise: boolean;
    chunkCountAtLeastOne: boolean;
    aggregateFinishReason: string | null;
    aggregateCandidateRole: string | null;
    aggregateTextMatchesConcatenatedChunks: boolean;
    historyLengthAfterStream: number;
    historyRolesAfterStream: string[];
    userTurnCountAfterStream: number;
    modelTurnCountAfterStream: number;
    recordedModelTurnTextMatchesAggregate: boolean;
  };
}

interface FunctionCallingBehavior {
  model: string;
  firstTurnForcedAny: {
    finishReason: string | null;
    functionCallPartPresent: boolean;
    functionCallKeySet: string[];
    functionCallIdIsNonEmptyString: boolean;
    functionCallName: string | null;
    argsIsPlainObject: boolean;
    argsKeySet: string[];
    functionCallsHelperCount: number;
    modelPartHasThoughtSignature: boolean;
  };
  secondTurnRoundTrip: {
    threadedModelTurnPreservedThoughtSignature: boolean;
    functionResponseRoleUsed: string;
    finishReason: string | null;
    candidateRole: string | null;
    answerHasTextPart: boolean;
    answerTextHelperNonEmpty: boolean;
    answerHasFunctionCallPart: boolean;
    functionCallsHelperUndefined: boolean;
  };
}

interface AppCheckErrorShape {
  threw: boolean;
  isAIError: boolean;
  isFirebaseError: boolean;
  code: string | null;
  status: number | null;
  statusText: string | null;
  messageIncludes401Unauthorized: boolean;
  messageIncludesInvalidAppCheckToken: boolean;
}

interface AppCheckStreamCountBehavior {
  model: string;
  withoutAppCheck: {
    generateContentStream: AppCheckErrorShape & { chunksYieldedBeforeRejection: number };
    countTokens: AppCheckErrorShape;
    streamAndCountTokensShareCodeAndStatus: boolean;
  };
  withAppCheck: {
    generateContentStream: {
      threw: boolean;
      chunkCountAtLeastOne: boolean;
      finishReason: string | null;
    };
    countTokens: {
      threw: boolean;
      hasTotalTokensKey: boolean;
      totalTokensIsPositiveInteger: boolean;
    };
  };
}

let appSeq = 0;
let activeCtx: HostCtx | null = null;

describe('served AI entry and SharedWorker Wave 2 SDK oracle parity', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          if (activeCtx !== null) {
            void handleMessage(activeCtx, hostPortLike, event.data as InboundMessage);
          }
        };
        this.port = clientPort;
      }
    };
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
      activeCtx = null;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedAi() {
    const ctx = await makeHostCtx();
    activeCtx = ctx;
    const servedAi = await import('../../../src/serve/entries/ai.js');
    return { ctx, servedAi };
  }

  it('replays streaming chunks and aggregate across SharedWorker port', async () => {
    const facts = readObservation<StreamingBehavior>('ai-sdk-streaming-chunks-and-aggregate');
    const { ctx, servedAi } = await setupServedAi();
    const appId = '1:123456789012:web:wave2workerstream';
    const app = createAppForSandbox(
      ctx.sandbox,
      { apiKey: 'fake-api-key', projectId: 'demo-ai-worker-wave2', appId },
      `wave2-worker-stream-${++appSeq}`,
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId, projectId: 'demo-ai-worker-wave2' }, 3600),
      }),
    });

    try {
      const ai = servedAi.getAI(app, {
        engine: { kind: 'scripted', script: [{ respond: { chunks: ['one ', 'two ', 'three'] } }] },
      });
      const model = servedAi.getGenerativeModel(ai, { model: facts.model });
      const result = await model.generateContentStream('Stream over worker.');
      const streamIsAsyncIterable =
        typeof (result.stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
        'function';

      const chunks: Array<{
        text(): string;
        functionCalls(): unknown;
        candidates?: Array<{ finishReason?: string; content?: { role?: string } }>;
        usageMetadata?: unknown;
      }> = [];
      const texts: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
        texts.push(chunk.text());
      }

      const finishIndexes: number[] = [];
      chunks.forEach((chunk, index) => {
        if (chunk.candidates?.[0]?.finishReason !== undefined) finishIndexes.push(index);
      });
      const lastChunk = chunks[chunks.length - 1];

      expect({
        streamIsAsyncIterable,
        chunkCountAtLeastOne: chunks.length >= 1,
        everyChunkHasTextHelper: chunks.every((c) => typeof c.text === 'function'),
        everyChunkHasFunctionCallsHelper: chunks.every(
          (c) => typeof c.functionCalls === 'function',
        ),
        everyChunkHasCandidatesOrUsage: chunks.every(
          (c) => Array.isArray(c.candidates) || c.usageMetadata !== undefined,
        ),
        everyChunkHasUsageMetadata: chunks.every((c) => c.usageMetadata !== undefined),
        everyChunkCandidateRoleModel: chunks.every(
          (c) => c.candidates?.[0]?.content?.role === 'model',
        ),
        nonFinalChunksOmitFinishReason: chunks
          .slice(0, -1)
          .every((c) => c.candidates?.[0]?.finishReason === undefined),
        finalChunkFinishReason: lastChunk?.candidates?.[0]?.finishReason ?? null,
        finishReasonOnlyOnLastChunk:
          finishIndexes.length === 1 && finishIndexes[0] === chunks.length - 1,
      }).toEqual(facts.stream);

      const aggregate = await result.response;
      expect(aggregate.text()).toBe(texts.join(''));
      expect(aggregate.candidates?.[0]?.content?.role ?? null).toBe(facts.aggregate.candidateRole);
      expect(aggregate.candidates?.[0]?.finishReason ?? null).toBe(facts.aggregate.finishReason);
      expect(aggregate.usageMetadata !== undefined).toBe(true);
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('replays ChatSession sendMessage and single-user-turn sendMessageStream across SharedWorker port', async () => {
    const facts = readObservation<ChatSessionBehavior>('ai-sdk-chat-session-send-and-stream');
    const { ctx, servedAi } = await setupServedAi();
    const appId = '1:123456789012:web:wave2workerchat';
    const app = createAppForSandbox(
      ctx.sandbox,
      { apiKey: 'fake-api-key', projectId: 'demo-ai-worker-wave2', appId },
      `wave2-worker-chat-${++appSeq}`,
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId, projectId: 'demo-ai-worker-wave2' }, 3600),
      }),
    });

    try {
      const ai = servedAi.getAI(app, {
        engine: {
          kind: 'scripted',
          script: [
            { respond: { text: 'worker-chat-reply' } },
            { respond: { chunks: ['worker-', 'stream-', 'chat'] } },
          ],
        },
      });
      const model = servedAi.getGenerativeModel(ai, { model: facts.model });

      const chat1 = model.startChat();
      const sendRes = await chat1.sendMessage('Hello worker chat.');
      const hist1 = await chat1.getHistory();
      const hist1Clone = await chat1.getHistory();
      expect(sendRes.response.candidates?.[0]?.content?.role ?? null).toBe(
        facts.sendMessage.candidateRole,
      );
      expect(sendRes.response.candidates?.[0]?.finishReason ?? null).toBe(
        facts.sendMessage.finishReason,
      );
      expect(sendRes.response.text().length > 0).toBe(facts.sendMessage.textHelperNonEmpty);
      expect(hist1.length).toBe(facts.sendMessage.historyLengthAfterSend);
      expect(hist1.map((t) => t.role)).toEqual(facts.sendMessage.historyRolesAfterSend);
      expect(hist1 === hist1Clone).toBe(false);

      const chat2 = model.startChat();
      const streamRes = await chat2.sendMessageStream('Stream worker chat.');
      const chunkTexts: string[] = [];
      let count = 0;
      for await (const chunk of streamRes.stream) {
        count += 1;
        chunkTexts.push(chunk.text());
      }
      const agg = await streamRes.response;
      const hist2 = await chat2.getHistory();
      const modelTurns = hist2.filter((t) => t.role === 'model');
      const recordedModelText = (modelTurns[0]?.parts ?? []).map((p) => p.text ?? '').join('');

      expect({
        hasAsyncIterableStream:
          typeof (streamRes.stream as { [Symbol.asyncIterator]?: unknown })[
            Symbol.asyncIterator
          ] === 'function',
        hasResponsePromise: typeof (streamRes.response as { then?: unknown }).then === 'function',
        chunkCountAtLeastOne: count >= 1,
        aggregateFinishReason: agg.candidates?.[0]?.finishReason ?? null,
        aggregateCandidateRole: agg.candidates?.[0]?.content?.role ?? null,
        aggregateTextMatchesConcatenatedChunks: agg.text() === chunkTexts.join(''),
        historyLengthAfterStream: hist2.length,
        historyRolesAfterStream: hist2.map((t) => t.role),
        userTurnCountAfterStream: hist2.filter((t) => t.role === 'user').length,
        modelTurnCountAfterStream: modelTurns.length,
        recordedModelTurnTextMatchesAggregate: recordedModelText === agg.text(),
      }).toEqual(facts.sendMessageStream);
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('replays function-calling Mode ANY and role user functionResponse round trip across SharedWorker port', async () => {
    const facts = readObservation<FunctionCallingBehavior>('ai-sdk-function-calling-roundtrip');
    const { ctx, servedAi } = await setupServedAi();
    const appId = '1:123456789012:web:wave2workerfn';
    const app = createAppForSandbox(
      ctx.sandbox,
      { apiKey: 'fake-api-key', projectId: 'demo-ai-worker-wave2', appId },
      `wave2-worker-fn-${++appSeq}`,
    );
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId, projectId: 'demo-ai-worker-wave2' }, 3600),
      }),
    });

    try {
      const ai = servedAi.getAI(app, {
        engine: {
          kind: 'scripted',
          script: [
            {
              match: 'Check Paris weather.',
              respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            },
            { respond: { text: 'Paris is clear and 20C.' } },
          ],
        },
      });
      const model = servedAi.getGenerativeModel(ai, {
        model: facts.model,
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Weather lookup.',
                parameters: servedAi.Schema.object({
                  properties: { city: servedAi.Schema.string() },
                }),
              },
            ],
          },
        ],
      });

      const userTurn = { role: 'user' as const, parts: [{ text: 'Check Paris weather.' }] };
      const turn1 = await model.generateContent({
        contents: [userTurn],
        toolConfig: { functionCallingConfig: { mode: servedAi.FunctionCallingMode.ANY } },
      });
      const cand1 = turn1.response.candidates?.[0];
      const modelContent1 = cand1?.content;
      const fnPart = (modelContent1?.parts ?? []).find((p) => p.functionCall !== undefined);
      const rawCall = fnPart?.functionCall as unknown as Record<string, unknown> | undefined;
      const rawArgs = rawCall?.args;
      const argsPlain =
        typeof rawArgs === 'object' && rawArgs !== null && Array.isArray(rawArgs) === false;
      let argsKeys: string[] = [];
      if (argsPlain) argsKeys = Object.keys(rawArgs as Record<string, unknown>).sort();
      const callsHelper = turn1.response.functionCalls();
      const sig = (fnPart as unknown as Record<string, unknown> | undefined)?.thoughtSignature;

      let callName: string | null = null;
      if (typeof rawCall?.name === 'string') callName = rawCall.name;
      let helperLen = 0;
      if (Array.isArray(callsHelper)) helperLen = callsHelper.length;

      expect({
        finishReason: cand1?.finishReason ?? null,
        functionCallPartPresent: fnPart !== undefined,
        functionCallKeySet: Object.keys(rawCall ?? {}).sort(),
        functionCallIdIsNonEmptyString:
          typeof rawCall?.id === 'string' && rawCall.id.length > 0,
        functionCallName: callName,
        argsIsPlainObject: argsPlain,
        argsKeySet: argsKeys,
        functionCallsHelperCount: helperLen,
        modelPartHasThoughtSignature: typeof sig === 'string' && sig.length > 0,
      }).toEqual(facts.firstTurnForcedAny);

      if (modelContent1 === undefined) throw new Error('Expected modelContent1');
      const turn2 = await model.generateContent({
        contents: [
          userTurn,
          modelContent1,
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'get_weather',
                  response: { temperatureC: 20, conditions: 'Clear' },
                },
              },
            ],
          },
        ],
      });
      const cand2 = turn2.response.candidates?.[0];
      const parts2 = cand2?.content?.parts ?? [];

      expect({
        threadedModelTurnPreservedThoughtSignature: typeof sig === 'string' && sig.length > 0,
        functionResponseRoleUsed: 'user',
        finishReason: cand2?.finishReason ?? null,
        candidateRole: cand2?.content?.role ?? null,
        answerHasTextPart: parts2.some((p) => typeof p.text === 'string' && p.text.length > 0),
        answerTextHelperNonEmpty: turn2.response.text().length > 0,
        answerHasFunctionCallPart: parts2.some((p) => p.functionCall !== undefined),
        functionCallsHelperUndefined: turn2.response.functionCalls() === undefined,
      }).toEqual(facts.secondTurnRoundTrip);
    } finally {
      await deleteApp(app);
      ctx.sandbox.dispose();
    }
  });

  it('replays App Check 401 gate on generateContentStream and countTokens across SharedWorker port', async () => {
    const facts = readObservation<AppCheckStreamCountBehavior>(
      'ai-sdk-app-check-stream-and-counttokens',
    );
    const { ctx, servedAi } = await setupServedAi();
    const unauthApp = createAppForSandbox(
      ctx.sandbox,
      {
        apiKey: 'fake-api-key',
        projectId: 'demo-ai-worker-wave2',
        appId: '1:123456789012:web:wave2workergate1',
      },
      `wave2-worker-unauth-${++appSeq}`,
    );
    const authAppId = '1:123456789012:web:wave2workergate2';
    const authApp = createAppForSandbox(
      ctx.sandbox,
      { apiKey: 'fake-api-key', projectId: 'demo-ai-worker-wave2', appId: authAppId },
      `wave2-worker-auth-${++appSeq}`,
    );
    initializeAppCheck(authApp, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId: authAppId, projectId: 'demo-ai-worker-wave2' }, 3600),
      }),
    });

    const classify = (err: unknown): AppCheckErrorShape => {
      let code: string | null = null;
      let status: number | null = null;
      let statusText: string | null = null;
      let msg = '';
      if (err && typeof err === 'object') {
        const rec = err as {
          code?: unknown;
          message?: unknown;
          customErrorData?: { status?: unknown; statusText?: unknown };
        };
        if (typeof rec.code === 'string') code = rec.code;
        if (typeof rec.message === 'string') msg = rec.message;
        if (rec.customErrorData && typeof rec.customErrorData === 'object') {
          if (typeof rec.customErrorData.status === 'number') status = rec.customErrorData.status;
          if (typeof rec.customErrorData.statusText === 'string') {
            statusText = rec.customErrorData.statusText;
          }
        }
      }
      return {
        threw: true,
        isAIError: err instanceof servedAi.AIError,
        isFirebaseError: err instanceof FirebaseError,
        code,
        status,
        statusText,
        messageIncludes401Unauthorized: msg.includes('401 Unauthorized'),
        messageIncludesInvalidAppCheckToken: msg.includes('Firebase App Check token is invalid'),
      };
    };

    try {
      const unauthModel = servedAi.getGenerativeModel(servedAi.getAI(unauthApp), {
        model: facts.model,
      });
      let chunksYieldedBeforeRejection = 0;
      let streamErr: AppCheckErrorShape | null = null;
      try {
        const res = await unauthModel.generateContentStream('Unauthenticated worker stream.');
        const attach = res.response.catch(() => undefined);
        for await (const _chunk of res.stream) {
          chunksYieldedBeforeRejection += 1;
        }
        await attach;
      } catch (err) {
        streamErr = classify(err);
      }

      let countErr: AppCheckErrorShape | null = null;
      try {
        await unauthModel.countTokens('Unauthenticated worker count.');
      } catch (err) {
        countErr = classify(err);
      }

      if (streamErr === null || countErr === null) {
        throw new Error('Expected worker App Check rejections');
      }
      expect({
        generateContentStream: { ...streamErr, chunksYieldedBeforeRejection },
        countTokens: countErr,
        streamAndCountTokensShareCodeAndStatus:
          streamErr.code === countErr.code && streamErr.status === countErr.status,
      }).toEqual(facts.withoutAppCheck);

      const authModel = servedAi.getGenerativeModel(
        servedAi.getAI(authApp, {
          engine: { kind: 'scripted', script: [{ respond: { chunks: ['w1 ', 'w2'] } }] },
        }),
        { model: facts.model },
      );
      const authStream = await authModel.generateContentStream('Authenticated worker stream.');
      let chunkCount = 0;
      for await (const _chunk of authStream.stream) chunkCount += 1;
      const authAgg = await authStream.response;
      const authCount = await authModel.countTokens('Authenticated worker count.');

      expect({
        generateContentStream: {
          threw: false,
          chunkCountAtLeastOne: chunkCount >= 1,
          finishReason: authAgg.candidates?.[0]?.finishReason ?? null,
        },
        countTokens: {
          threw: false,
          hasTotalTokensKey: 'totalTokens' in authCount,
          totalTokensIsPositiveInteger:
            Number.isInteger(authCount.totalTokens) && authCount.totalTokens > 0,
        },
      }).toEqual(facts.withAppCheck);
    } finally {
      await deleteApp(unauthApp);
      await deleteApp(authApp);
      ctx.sandbox.dispose();
    }
  });
});
