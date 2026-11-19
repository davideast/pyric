import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 50,
  featureKeys: ['sendMessageStream'],
  api: 'ChatSession.sendMessageStream()',
  behavior:
    '`sendMessageStream` returns a stream plus a response promise; history updates after aggregation completes',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-sdk-chat-session-send-and-stream` replayed across in-process (`wave2-sdk-oracle.test.ts`, `chat-session.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-sdk-chat-session-send-and-stream'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'chat-session.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-SENDMESSAGESTREAM',
      observation: 'ai-sdk-chat-session-send-and-stream',
      expect: {
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
      },
      probe: PROBE,
      guards: 'ChatSession.sendMessageStream yields async-iterable chunks, settles response to concatenated text, and appends user + model turns to history.',
    },
  ],
});
