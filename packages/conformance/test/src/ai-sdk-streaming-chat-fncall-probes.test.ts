import { describe, expect, test } from 'bun:test';
import { FirebaseError } from 'firebase/app';
import { AIError, AIErrorCode } from 'firebase/ai';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
import {
  type AppCheckErrorClassifier,
  type AppCheckGateModelSubject,
  observeAppCheckStreamAndCountTokens,
  probe as appCheckStreamCountProbe,
} from '../../probes/ai/ai-sdk-app-check-stream-and-counttokens.ts';
import {
  type ChatSessionProbeModelSubject,
  observeChatSessionSendAndStream,
  probe as chatSessionProbe,
} from '../../probes/ai/ai-sdk-chat-session-send-and-stream.ts';
import {
  type FunctionCallingRoundtripDriver,
  observeFunctionCallingRoundtrip,
  probe as functionCallingProbe,
} from '../../probes/ai/ai-sdk-function-calling-roundtrip.ts';
import {
  type StreamingProbeModelSubject,
  observeStreamingChunksAndAggregate,
  probe as streamingProbe,
} from '../../probes/ai/ai-sdk-streaming-chunks-and-aggregate.ts';

const AI_SDK_WAVE2_STREAMING_CHAT_FNCALL_PROBE_IDS = [
  'ai-sdk-app-check-stream-and-counttokens',
  'ai-sdk-chat-session-send-and-stream',
  'ai-sdk-function-calling-roundtrip',
  'ai-sdk-streaming-chunks-and-aggregate',
] as const;

const AI_SDK_WAVE2_STAGED_PROBE_IDS: readonly string[] = [];

describe('AI Wave 2 live client SDK probes (streaming, ChatSession, function-calling, App Check)', () => {
  test('links all 4 captured sdk-probes to registry rows without pendingRowLink', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of AI_SDK_WAVE2_STREAMING_CHAT_FNCALL_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const linkedProbes = [
      appCheckStreamCountProbe,
      chatSessionProbe,
      functionCallingProbe,
      streamingProbe,
    ];
    for (const probeRecord of linkedProbes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    expect(streamingProbe.matrixRow).toBe('ai#stream-async-iterable');
    expect(streamingProbe.rowIds).toEqual([
      'ai#stream-async-iterable',
      'ai#stream-chunk-envelope',
      'ai#stream-finish-last-chunk',
      'ai#stream-usage-every-chunk',
      'ai#stream-response-aggregate',
      'ai#stream-aggregate-final-meta',
    ]);

    expect(chatSessionProbe.matrixRow).toBe('ai#chat-sendmessage-envelope');
    expect(chatSessionProbe.rowIds).toEqual([
      'ai#chat-sendmessage-envelope',
      'ai#chat-sendmessagestream',
      'ai#chat-stream-single-user-turn',
      'ai#chat-history-threads',
    ]);

    expect(functionCallingProbe.matrixRow).toBe('ai#fncall-round-trip');
    expect(functionCallingProbe.rowIds).toEqual([
      'ai#fncall-part-shape',
      'ai#fncall-mode-any',
      'ai#fncall-id-present',
      'ai#fncall-round-trip',
    ]);

    expect(appCheckStreamCountProbe.matrixRow).toBe('ai#sandbox-app-check-stream-and-count-tokens');
    expect(appCheckStreamCountProbe.rowIds).toEqual([
      'ai#sandbox-app-check-stream-and-count-tokens',
    ]);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of AI_SDK_WAVE2_STREAMING_CHAT_FNCALL_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    expectStagedUntilCaptured(AI_SDK_WAVE2_STAGED_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    for (const id of AI_SDK_WAVE2_STREAMING_CHAT_FNCALL_PROBE_IDS) {
      expect(
        previewLines.some((line) => line.includes(`${id}`) && !line.includes('[pendingRowLink]')),
      ).toBe(true);
    }
  });

  test('observeStreamingChunksAndAggregate extracts deterministic structural facts without volatile counts or prose', async () => {
    const fakeChunks = [
      {
        text: () => '1 2 3 ',
        functionCalls: () => undefined,
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '1 2 3 ' }] } }],
        usageMetadata: { promptTokenCount: 12, totalTokenCount: 18 },
      },
      {
        text: () => '4 5',
        functionCalls: () => undefined,
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            content: { role: 'model', parts: [{ text: '4 5' }] },
          },
        ],
        usageMetadata: { promptTokenCount: 12, totalTokenCount: 22 },
      },
    ];
    const model: StreamingProbeModelSubject = {
      async generateContentStream() {
        return {
          async *stream() {
            for (const item of fakeChunks) {
              yield item;
            }
          },
          response: Promise.resolve({
            text: () => '1 2 3 4 5',
            functionCalls: () => undefined,
            candidates: [
              {
                index: 0,
                finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: '1 2 3 ' }, { text: '4 5' }] },
              },
            ],
            usageMetadata: { promptTokenCount: 12, totalTokenCount: 22 },
            modelVersion: 'gemini-flash-lite-sample',
            responseId: 'sample-id',
            inferenceSource: 'in_cloud',
          }),
        } as unknown as Awaited<ReturnType<StreamingProbeModelSubject['generateContentStream']>>;
      },
    };
    // Wrap generator function as AsyncIterable
    const iterableModel: StreamingProbeModelSubject = {
      async generateContentStream(prompt: string) {
        const base = await model.generateContentStream(prompt);
        const genFn = base.stream as unknown as () => AsyncIterable<
          (typeof fakeChunks)[number]
        >;
        return {
          stream: genFn(),
          response: base.response,
        };
      },
    };

    const facts = await observeStreamingChunksAndAggregate(iterableModel);
    expect(facts).toEqual({
      model: 'gemini-flash-lite-latest',
      stream: {
        streamIsAsyncIterable: true,
        chunkCountAtLeastOne: true,
        everyChunkHasTextHelper: true,
        everyChunkHasFunctionCallsHelper: true,
        everyChunkHasCandidatesOrUsage: true,
        everyChunkHasUsageMetadata: true,
        everyChunkCandidateRoleModel: true,
        nonFinalChunksOmitFinishReason: true,
        finalChunkFinishReason: 'STOP',
        finishReasonOnlyOnLastChunk: true,
      },
      aggregate: {
        hasTextHelper: true,
        aggregateTextNonEmpty: true,
        aggregateTextMatchesConcatenatedChunks: true,
        candidateRole: 'model',
        finishReason: 'STOP',
        hasUsageMetadata: true,
        hasModelVersion: true,
        hasResponseId: true,
        inferenceSource: 'in_cloud',
      },
    });
  });

  test('observeChatSessionSendAndStream records envelope, stream settlement, and single-user-turn history', async () => {
    let chatIndex = 0;
    const model: ChatSessionProbeModelSubject = {
      startChat() {
        chatIndex += 1;
        const history: Array<{ role: string; parts: Array<{ text?: string }> }> = [];
        return {
          async sendMessage(prompt: string) {
            history.push({ role: 'user', parts: [{ text: prompt }] });
            history.push({ role: 'model', parts: [{ text: 'alpha' }] });
            return {
              response: {
                text: () => 'alpha',
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { role: 'model', parts: [{ text: 'alpha' }] },
                  },
                ],
                usageMetadata: { totalTokenCount: 10 },
                modelVersion: 'gemini-flash-lite-sample',
                responseId: 'resp-1',
                inferenceSource: 'in_cloud',
              },
            };
          },
          async sendMessageStream(prompt: string) {
            const chunks = [
              {
                text: () => '1 2 ',
                candidates: [{ content: { role: 'model', parts: [{ text: '1 2 ' }] } }],
              },
              {
                text: () => '3',
                candidates: [
                  {
                    finishReason: 'STOP',
                    content: { role: 'model', parts: [{ text: '3' }] },
                  },
                ],
              },
            ];
            async function* iterate() {
              for (const chunk of chunks) {
                yield chunk;
              }
              history.push({ role: 'user', parts: [{ text: prompt }] });
              history.push({ role: 'model', parts: [{ text: '1 2 3' }] });
            }
            const stream = iterate();
            const response = Promise.resolve({
              text: () => '1 2 3',
              candidates: [
                {
                  finishReason: 'STOP',
                  content: { role: 'model', parts: [{ text: '1 2 3' }] },
                },
              ],
            });
            return { stream, response };
          },
          async getHistory() {
            return history;
          },
        };
      },
    };

    const facts = await observeChatSessionSendAndStream(model);
    expect(chatIndex).toBe(2);
    expect(facts).toEqual({
      model: 'gemini-flash-lite-latest',
      sendMessage: {
        wireFourKeysPresent: true,
        nonFunctionOwnKeysSorted: [
          'candidates',
          'inferenceSource',
          'modelVersion',
          'responseId',
          'usageMetadata',
        ],
        candidateRole: 'model',
        finishReason: 'STOP',
        textHelperNonEmpty: true,
        historyLengthAfterSend: 2,
        historyRolesAfterSend: ['user', 'model'],
        getHistoryReturnsSameArrayReference: true,
      },
      sendMessageStream: {
        hasAsyncIterableStream: true,
        hasResponsePromise: true,
        chunkCountAtLeastOne: true,
        aggregateFinishReason: 'STOP',
        aggregateCandidateRole: 'model',
        aggregateTextMatchesConcatenatedChunks: true,
        historyLengthAfterStream: 2,
        historyRolesAfterStream: ['user', 'model'],
        userTurnCountAfterStream: 1,
        modelTurnCountAfterStream: 1,
        recordedModelTurnTextMatchesAggregate: true,
      },
    });
  });

  test('observeFunctionCallingRoundtrip threads thoughtSignature on turn 2 with role user functionResponse', async () => {
    let observedSecondTurnRoles: string[] = [];
    const driver: FunctionCallingRoundtripDriver = {
      async generateForcedFirstTurn() {
        const call = { id: 'call_1', name: 'get_weather', args: { city: 'Paris' } };
        return {
          response: {
            text: () => '',
            functionCalls: () => [call],
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: call,
                      thoughtSignature: 'opaque-sig-token',
                    },
                  ],
                },
              },
            ],
          },
        };
      },
      async generateRoundTripSecondTurn(contents) {
        observedSecondTurnRoles = contents.map((turn) => turn.role);
        return {
          response: {
            text: () => 'Clear skies and 22C in Paris.',
            functionCalls: () => undefined,
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [{ text: 'Clear skies and 22C in Paris.' }],
                },
              },
            ],
          },
        };
      },
    };

    const facts = await observeFunctionCallingRoundtrip(driver);
    expect(observedSecondTurnRoles).toEqual(['user', 'model', 'user']);
    expect(facts).toEqual({
      model: 'gemini-flash-lite-latest',
      firstTurnForcedAny: {
        finishReason: 'STOP',
        functionCallPartPresent: true,
        functionCallKeySet: ['args', 'id', 'name'],
        functionCallIdIsNonEmptyString: true,
        functionCallName: 'get_weather',
        argsIsPlainObject: true,
        argsKeySet: ['city'],
        functionCallsHelperCount: 1,
        modelPartHasThoughtSignature: true,
      },
      secondTurnRoundTrip: {
        threadedModelTurnPreservedThoughtSignature: true,
        functionResponseRoleUsed: 'user',
        finishReason: 'STOP',
        candidateRole: 'model',
        answerHasTextPart: true,
        answerTextHelperNonEmpty: true,
        answerHasFunctionCallPart: false,
        functionCallsHelperUndefined: true,
      },
    });
  });

  test('observeAppCheckStreamAndCountTokens redacts project URLs and records pre-chunk 401 AIError parity', async () => {
    const make401 = () =>
      new AIError(
        AIErrorCode.FETCH_ERROR,
        'Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/secret-proj/models/gemini-flash-lite-latest:streamGenerateContent?alt=sse: [401 Unauthorized] Firebase App Check token is invalid.',
        {
          status: 401,
          statusText: 'Unauthorized',
        },
      );

    const unauthenticatedModel: AppCheckGateModelSubject = {
      async generateContentStream() {
        async function* failingStream(): AsyncGenerator<{ text(): string }> {
          yield* [];
          throw make401();
        }
        return {
          stream: failingStream(),
          response: Promise.reject(make401()),
        };
      },
      async countTokens() {
        throw make401();
      },
    };

    const authenticatedModel: AppCheckGateModelSubject = {
      async generateContentStream() {
        async function* okStream() {
          yield { text: () => '1 2', candidates: [{ finishReason: 'STOP' }] };
        }
        return {
          stream: okStream(),
          response: Promise.resolve({
            text: () => '1 2',
            candidates: [{ finishReason: 'STOP' }],
          }),
        };
      },
      async countTokens() {
        return { totalTokens: 9 };
      },
    };

    const classifier: AppCheckErrorClassifier = {
      isAIError: (err) => err instanceof AIError,
      isFirebaseError: (err) => err instanceof FirebaseError,
    };

    const facts = await observeAppCheckStreamAndCountTokens({
      unauthenticatedModel,
      authenticatedModel,
      classifier,
    });
    const serialized = JSON.stringify(facts);
    expect(serialized.includes('secret-proj')).toBe(false);
    expect(facts).toEqual({
      model: 'gemini-flash-lite-latest',
      withoutAppCheck: {
        generateContentStream: {
          threw: true,
          chunksYieldedBeforeRejection: 0,
          isAIError: true,
          isFirebaseError: true,
          code: 'fetch-error',
          status: 401,
          statusText: 'Unauthorized',
          messageIncludes401Unauthorized: true,
          messageIncludesInvalidAppCheckToken: true,
        },
        countTokens: {
          threw: true,
          isAIError: true,
          isFirebaseError: true,
          code: 'fetch-error',
          status: 401,
          statusText: 'Unauthorized',
          messageIncludes401Unauthorized: true,
          messageIncludesInvalidAppCheckToken: true,
        },
        streamAndCountTokensShareCodeAndStatus: true,
      },
      withAppCheck: {
        generateContentStream: {
          threw: false,
          chunkCountAtLeastOne: true,
          finishReason: 'STOP',
        },
        countTokens: {
          threw: false,
          hasTotalTokensKey: true,
          totalTokensIsPositiveInteger: true,
        },
      },
    });
  });
});
