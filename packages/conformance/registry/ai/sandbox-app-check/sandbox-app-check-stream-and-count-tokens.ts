import { ERROR_RISK } from '../defaults.ts';
import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['generateContentStream', 'countTokens'],
  api: 'generateContentStream and countTokens without App Check in sandbox AI mode',
  behavior:
    'Streaming and `countTokens` are refused with the same 401 `AIError` as `generateContent`. `generateContentStream` rejects the call itself before yielding any chunk across in-process, in-page, SharedWorker, and Node host planes.',
  automation: 'oracle-backed',
  ...ERROR_RISK,
  evidence:
    'Captures `app-check-ai-gate-wire` and `ai-sdk-app-check-stream-and-counttokens` replayed across in-process (`wave2-sdk-oracle.test.ts`, `app-check-gate.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`, `ai-ops.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`, `test/apps/sandbox-app-check`) planes.',
  oracleObservations: ['ai-sdk-app-check-stream-and-counttokens'],
  conformanceTests: [
    'packages/pyric/test/ai/wave2-sdk-oracle.test.ts',
    'packages/pyric/test/ai/app-check-gate.test.ts',
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'packages/cli/test/serve/worker/ai-ops.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
    'test/apps/sandbox-app-check/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-SANDBOX-APP-CHECK-STREAM-AND-COUNT-TOKENS',
      observation: 'ai-sdk-app-check-stream-and-counttokens',
      expect: {
        withoutAppCheck: {
          generateContentStream: {
            threw: true,
            isAIError: true,
            isFirebaseError: true,
            code: 'fetch-error',
            status: 401,
            statusText: 'Unauthorized',
            messageIncludes401Unauthorized: true,
            messageIncludesInvalidAppCheckToken: true,
            chunksYieldedBeforeRejection: 0,
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
      },
      probe: PROBE,
      guards: 'Without App Check, generateContentStream rejects before yielding chunks and countTokens rejects with the same 401 fetch-error AIError; with App Check, both succeed.',
    },
  ],
});
