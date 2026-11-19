/**
 * Oracle conformance replay for Wave 2 live client SDK captures:
 *   - `ai-sdk-streaming-chunks-and-aggregate`
 *   - `ai-sdk-chat-session-send-and-stream`
 *   - `ai-sdk-function-calling-roundtrip`
 *   - `ai-sdk-app-check-stream-and-counttokens`
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError, deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import { initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from 'pyric/sandbox/internal';
import {
  AIError,
  FunctionCallingMode,
  Schema,
  getAI,
  getGenerativeModel,
  type Content,
  type EnhancedGenerateContentResponse,
  type Part,
} from 'pyric/ai';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', 'conformance', 'observations', 'ai');

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
    hasUsageMetadata: boolean;
    hasModelVersion: boolean;
    hasResponseId: boolean;
    inferenceSource: string | null;
  };
}

interface ChatSessionBehavior {
  model: string;
  sendMessage: {
    wireFourKeysPresent: boolean;
    nonFunctionOwnKeysSorted: string[];
    candidateRole: string | null;
    finishReason: string | null;
    textHelperNonEmpty: boolean;
    historyLengthAfterSend: number;
    historyRolesAfterSend: string[];
    getHistoryReturnsSameArrayReference: boolean;
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

function nonFunctionKeysSorted(value: object): string[] {
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .filter((key) => typeof record[key] !== 'function')
    .sort();
}

function classifyAiThrow(err: unknown): AppCheckErrorShape {
  let code: string | null = null;
  let status: number | null = null;
  let statusText: string | null = null;
  let message = '';
  if (err && typeof err === 'object') {
    const rec = err as {
      code?: unknown;
      message?: unknown;
      customErrorData?: { status?: unknown; statusText?: unknown };
    };
    if (typeof rec.code === 'string') code = rec.code;
    if (typeof rec.message === 'string') message = rec.message;
    if (rec.customErrorData && typeof rec.customErrorData === 'object') {
      if (typeof rec.customErrorData.status === 'number') status = rec.customErrorData.status;
      if (typeof rec.customErrorData.statusText === 'string') {
        statusText = rec.customErrorData.statusText;
      }
    }
  }
  return {
    threw: true,
    isAIError: err instanceof AIError,
    isFirebaseError: err instanceof FirebaseError,
    code,
    status,
    statusText,
    messageIncludes401Unauthorized: message.includes('401 Unauthorized'),
    messageIncludesInvalidAppCheckToken: message.includes(
      'Firebase App Check token is invalid',
    ),
  };
}

function makeSandboxApp(
  sandbox: ReturnType<typeof initializeSandbox>,
  name: string,
  appId: string,
  withToken: boolean,
) {
  const app = createAppForSandbox(
    sandbox,
    { apiKey: 'fake-api-key', projectId: 'demo-ai-wave2', appId },
    name,
  );
  if (withToken) {
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => mintAppCheckToken({ appId, projectId: 'demo-ai-wave2' }, 3600),
      }),
    });
  }
  return app;
}

describe('oracle replay: Wave 2 live firebase/ai SDK captures', () => {
  it('replays ai-sdk-streaming-chunks-and-aggregate and pins aggregate metadata carry delta', async () => {
    const facts = readObservation<StreamingBehavior>('ai-sdk-streaming-chunks-and-aggregate');
    const sandbox = initializeSandbox();
    const app = makeSandboxApp(sandbox, 'wave2-inproc-stream', '1:100000000000:web:wave2stream01', true);

    try {
      const ai = getAI(app, {
        engine: {
          kind: 'scripted',
          script: [{ respond: { chunks: ['alpha ', 'beta ', 'gamma'] } }],
        },
      });
      const model = getGenerativeModel(ai, { model: facts.model });
      const result = await model.generateContentStream('Stream three words.');
      const streamIsAsyncIterable =
        typeof (result.stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
        'function';

      const chunks: EnhancedGenerateContentResponse[] = [];
      const chunkTexts: string[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
        chunkTexts.push(chunk.text());
      }

      const finishIndexes: number[] = [];
      chunks.forEach((chunk, index) => {
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason !== undefined) {
          finishIndexes.push(index);
        }
      });
      const lastChunk = chunks[chunks.length - 1];
      const finalChunkFinishReason = lastChunk?.candidates?.[0]?.finishReason ?? null;

      expect({
        streamIsAsyncIterable,
        chunkCountAtLeastOne: chunks.length >= 1,
        everyChunkHasTextHelper: chunks.every((chunk) => typeof chunk.text === 'function'),
        everyChunkHasFunctionCallsHelper: chunks.every(
          (chunk) => typeof chunk.functionCalls === 'function',
        ),
        everyChunkHasCandidatesOrUsage: chunks.every(
          (chunk) => Array.isArray(chunk.candidates) || chunk.usageMetadata !== undefined,
        ),
        everyChunkHasUsageMetadata: chunks.every((chunk) => chunk.usageMetadata !== undefined),
        everyChunkCandidateRoleModel: chunks.every(
          (chunk) => chunk.candidates?.[0]?.content?.role === 'model',
        ),
        nonFinalChunksOmitFinishReason: chunks
          .slice(0, -1)
          .every((chunk) => chunk.candidates?.[0]?.finishReason === undefined),
        finalChunkFinishReason,
        finishReasonOnlyOnLastChunk:
          finishIndexes.length === 1 && finishIndexes[0] === chunks.length - 1,
      }).toEqual(facts.stream);

      const aggregate = await result.response;
      expect(typeof aggregate.text === 'function').toBe(facts.aggregate.hasTextHelper);
      expect(aggregate.text().length > 0).toBe(facts.aggregate.aggregateTextNonEmpty);
      expect(aggregate.text() === chunkTexts.join('')).toBe(
        facts.aggregate.aggregateTextMatchesConcatenatedChunks,
      );
      expect(aggregate.candidates?.[0]?.content?.role ?? null).toBe(facts.aggregate.candidateRole);
      expect(aggregate.candidates?.[0]?.finishReason ?? null).toBe(facts.aggregate.finishReason);

      // Pinned ai#stream-aggregate-final-meta delta: upstream drops terminal metadata on aggregate; Pyric carries it.
      expect(facts.aggregate.hasUsageMetadata).toBe(false);
      expect(facts.aggregate.hasModelVersion).toBe(false);
      expect(facts.aggregate.hasResponseId).toBe(false);
      expect(aggregate.usageMetadata !== undefined).toBe(true);
      expect(typeof (aggregate as { modelVersion?: unknown }).modelVersion).toBe('string');
      expect(typeof (aggregate as { responseId?: unknown }).responseId).toBe('string');
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('replays ai-sdk-chat-session-send-and-stream including single-user-turn stream parity and clone delta', async () => {
    const facts = readObservation<ChatSessionBehavior>('ai-sdk-chat-session-send-and-stream');
    const wireEnvelope = readObservation<{ topLevelKeySet: string[] }>(
      'ai-generate-minimal-envelope',
    );
    const sandbox = initializeSandbox();
    const app = makeSandboxApp(sandbox, 'wave2-inproc-chat', '1:100000000000:web:wave2chat01', true);

    try {
      const ai = getAI(app, {
        engine: {
          kind: 'scripted',
          script: [
            { respond: { text: 'chat-reply-alpha' } },
            { respond: { chunks: ['stream-', 'reply-', 'beta'] } },
          ],
        },
      });
      const model = getGenerativeModel(ai, { model: facts.model });

      const sendChat = model.startChat();
      const sendResult = await sendChat.sendMessage('Say alpha.');
      const historyA = await sendChat.getHistory();
      const historyB = await sendChat.getHistory();

      expect(sendResult.response.candidates?.[0]?.content?.role ?? null).toBe(
        facts.sendMessage.candidateRole,
      );
      expect(sendResult.response.candidates?.[0]?.finishReason ?? null).toBe(
        facts.sendMessage.finishReason,
      );
      expect(sendResult.response.text().length > 0).toBe(facts.sendMessage.textHelperNonEmpty);
      expect(historyA.length).toBe(facts.sendMessage.historyLengthAfterSend);
      expect(historyA.map((turn) => turn.role)).toEqual(facts.sendMessage.historyRolesAfterSend);

      // Pinned wire 4-key preservation vs client mapGenerateContentResponse, and defensive clone delta.
      expect(facts.sendMessage.wireFourKeysPresent).toBe(false);
      expect(nonFunctionKeysSorted(sendResult.response)).toEqual(
        [...wireEnvelope.topLevelKeySet].sort(),
      );
      expect(facts.sendMessage.getHistoryReturnsSameArrayReference).toBe(true);
      expect(historyA === historyB).toBe(false);

      const streamChat = model.startChat();
      const streamResult = await streamChat.sendMessageStream('Say beta in chunks.');
      const hasAsyncIterableStream =
        typeof (streamResult.stream as { [Symbol.asyncIterator]?: unknown })[
          Symbol.asyncIterator
        ] === 'function';
      const hasResponsePromise =
        typeof (streamResult.response as { then?: unknown }).then === 'function';

      const chunkTexts: string[] = [];
      let chunkCount = 0;
      for await (const chunk of streamResult.stream) {
        chunkCount += 1;
        chunkTexts.push(chunk.text());
      }
      const streamAggregate = await streamResult.response;
      const streamHistory = await streamChat.getHistory();
      const modelTurns = streamHistory.filter((turn) => turn.role === 'model');
      const recordedModelText = (modelTurns[0]?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');

      expect({
        hasAsyncIterableStream,
        hasResponsePromise,
        chunkCountAtLeastOne: chunkCount >= 1,
        aggregateFinishReason: streamAggregate.candidates?.[0]?.finishReason ?? null,
        aggregateCandidateRole: streamAggregate.candidates?.[0]?.content?.role ?? null,
        aggregateTextMatchesConcatenatedChunks: streamAggregate.text() === chunkTexts.join(''),
        historyLengthAfterStream: streamHistory.length,
        historyRolesAfterStream: streamHistory.map((turn) => turn.role),
        userTurnCountAfterStream: streamHistory.filter((turn) => turn.role === 'user').length,
        modelTurnCountAfterStream: modelTurns.length,
        recordedModelTurnTextMatchesAggregate: recordedModelText === streamAggregate.text(),
      }).toEqual(facts.sendMessageStream);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('replays ai-sdk-function-calling-roundtrip under FunctionCallingMode.ANY and role user functionResponse', async () => {
    const facts = readObservation<FunctionCallingBehavior>('ai-sdk-function-calling-roundtrip');
    const sandbox = initializeSandbox();
    const app = makeSandboxApp(sandbox, 'wave2-inproc-fncall', '1:100000000000:web:wave2fn01', true);

    try {
      const ai = getAI(app, {
        engine: {
          kind: 'scripted',
          script: [
            {
              match: /weather in Paris/,
              respond: { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            },
            { respond: { text: 'Paris is sunny and 21C.' } },
          ],
        },
      });
      const model = getGenerativeModel(ai, {
        model: facts.model,
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Look up weather for a city.',
                parameters: Schema.object({
                  properties: { city: Schema.string() },
                }),
              },
            ],
          },
        ],
      });

      const userTurn: Content = {
        role: 'user',
        parts: [{ text: 'Call get_weather for the weather in Paris.' }],
      };
      const turn1 = await model.generateContent({
        contents: [userTurn],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
      });
      const candidate1 = turn1.response.candidates?.[0];
      const modelContent1 = candidate1?.content;
      const parts1: Part[] = modelContent1?.parts ?? [];
      const fnCallPart = parts1.find((part) => part.functionCall !== undefined);
      const rawCall = fnCallPart?.functionCall as unknown as Record<string, unknown> | undefined;
      const callArgs = rawCall?.args;
      const argsPlainObject =
        typeof callArgs === 'object' && callArgs !== null && Array.isArray(callArgs) === false;
      let argsKeys: string[] = [];
      if (argsPlainObject) {
        argsKeys = Object.keys(callArgs as Record<string, unknown>).sort();
      }
      const helperCalls = turn1.response.functionCalls();
      const rawPartRecord = fnCallPart as unknown as Record<string, unknown> | undefined;
      const sigValue = rawPartRecord?.thoughtSignature;
      let callName: string | null = null;
      if (typeof rawCall?.name === 'string') {
        callName = rawCall.name;
      }
      let helperCallsCount = 0;
      if (Array.isArray(helperCalls)) {
        helperCallsCount = helperCalls.length;
      }

      expect({
        finishReason: candidate1?.finishReason ?? null,
        functionCallPartPresent: fnCallPart !== undefined,
        functionCallKeySet: Object.keys(rawCall ?? {}).sort(),
        functionCallIdIsNonEmptyString:
          typeof rawCall?.id === 'string' && rawCall.id.length > 0,
        functionCallName: callName,
        argsIsPlainObject: argsPlainObject,
        argsKeySet: argsKeys,
        functionCallsHelperCount: helperCallsCount,
        modelPartHasThoughtSignature: typeof sigValue === 'string' && sigValue.length > 0,
      }).toEqual(facts.firstTurnForcedAny);

      if (modelContent1 === undefined) {
        throw new Error('Expected turn 1 model content');
      }
      const threadedHasSig = modelContent1.parts.some((part) => {
        const rec = part as unknown as Record<string, unknown>;
        return typeof rec.thoughtSignature === 'string' && rec.thoughtSignature.length > 0;
      });
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
                  response: { temperatureC: 21, conditions: 'Sunny' },
                },
              },
            ],
          },
        ],
      });
      const candidate2 = turn2.response.candidates?.[0];
      const parts2 = candidate2?.content?.parts ?? [];

      expect({
        threadedModelTurnPreservedThoughtSignature: threadedHasSig,
        functionResponseRoleUsed: 'user',
        finishReason: candidate2?.finishReason ?? null,
        candidateRole: candidate2?.content?.role ?? null,
        answerHasTextPart: parts2.some(
          (part) => typeof part.text === 'string' && part.text.length > 0,
        ),
        answerTextHelperNonEmpty: turn2.response.text().length > 0,
        answerHasFunctionCallPart: parts2.some((part) => part.functionCall !== undefined),
        functionCallsHelperUndefined: turn2.response.functionCalls() === undefined,
      }).toEqual(facts.secondTurnRoundTrip);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('replays ai-sdk-app-check-stream-and-counttokens 401 refusal before chunks and authenticated success', async () => {
    const facts = readObservation<AppCheckStreamCountBehavior>(
      'ai-sdk-app-check-stream-and-counttokens',
    );
    const sandbox = initializeSandbox();
    const unauthApp = makeSandboxApp(sandbox, 'wave2-inproc-unauth', '1:100000000000:web:wave2gate01', false);
    const authApp = makeSandboxApp(sandbox, 'wave2-inproc-auth', '1:100000000000:web:wave2gate02', true);

    try {
      const unauthModel = getGenerativeModel(getAI(unauthApp), { model: facts.model });
      let chunksYieldedBeforeRejection = 0;
      let streamError: AppCheckErrorShape | null = null;
      try {
        const res = await unauthModel.generateContentStream('Ping unauthenticated stream.');
        const attach = res.response.catch(() => undefined);
        for await (const _chunk of res.stream) {
          chunksYieldedBeforeRejection += 1;
        }
        await attach;
      } catch (err) {
        streamError = classifyAiThrow(err);
      }

      let countError: AppCheckErrorShape | null = null;
      try {
        await unauthModel.countTokens('Ping unauthenticated count.');
      } catch (err) {
        countError = classifyAiThrow(err);
      }

      expect(streamError).not.toBeNull();
      expect(countError).not.toBeNull();
      if (streamError === null || countError === null) {
        throw new Error('Expected both unauthenticated calls to reject');
      }

      expect({
        generateContentStream: {
          ...streamError,
          chunksYieldedBeforeRejection,
        },
        countTokens: countError,
        streamAndCountTokensShareCodeAndStatus:
          streamError.code === countError.code && streamError.status === countError.status,
      }).toEqual(facts.withoutAppCheck);

      const authModel = getGenerativeModel(
        getAI(authApp, {
          engine: { kind: 'scripted', script: [{ respond: { chunks: ['ok-1 ', 'ok-2'] } }] },
        }),
        { model: facts.model },
      );
      const authStream = await authModel.generateContentStream('Authenticated stream.');
      let authChunkCount = 0;
      for await (const _chunk of authStream.stream) {
        authChunkCount += 1;
      }
      const authAgg = await authStream.response;
      const authTokens = await authModel.countTokens('Authenticated count.');

      expect({
        generateContentStream: {
          threw: false,
          chunkCountAtLeastOne: authChunkCount >= 1,
          finishReason: authAgg.candidates?.[0]?.finishReason ?? null,
        },
        countTokens: {
          threw: false,
          hasTotalTokensKey: 'totalTokens' in authTokens,
          totalTokensIsPositiveInteger:
            Number.isInteger(authTokens.totalTokens) && authTokens.totalTokens > 0,
        },
      }).toEqual(facts.withAppCheck);
    } finally {
      await deleteApp(unauthApp);
      await deleteApp(authApp);
      sandbox.dispose();
    }
  });
});
