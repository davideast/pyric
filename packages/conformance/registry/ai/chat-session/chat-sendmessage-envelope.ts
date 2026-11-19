import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['sendMessage'],
  api: 'ChatSession.sendMessage()',
  behavior:
    'A `sendMessage` result carries the same envelope facts as `generateContent`: the four top-level keys and role `model`',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-generate-minimal-envelope` and `ai-sdk-chat-session-send-and-stream` replayed across in-process (`wave2-sdk-oracle.test.ts`, `chat-session.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-generate-minimal-envelope', 'ai-sdk-chat-session-send-and-stream'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'chat-session.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-CHAT-SENDMESSAGE-ENVELOPE',
      observation: 'ai-sdk-chat-session-send-and-stream',
      expect: {
        sendMessage: {
          wireFourKeysPresent: false,
          nonFunctionOwnKeysSorted: ['candidates', 'inferenceSource', 'prompt', 'usageMetadata'],
          candidateRole: 'model',
          finishReason: 'STOP',
          textHelperNonEmpty: true,
          historyLengthAfterSend: 2,
          historyRolesAfterSend: ['user', 'model'],
          getHistoryReturnsSameArrayReference: true,
        },
      },
      probe: PROBE,
      guards: 'ChatSession.sendMessage returns candidateRole model, finishReason STOP, text() helper, and preserves the wire four-key GenerateContentResponse envelope.',
    },
  ],
  notes:
    'Pyric preserves the GoogleAI wire four-key set (`candidates`, `modelVersion`, `responseId`, `usageMetadata` from `ai-generate-minimal-envelope`), whereas client-side `mapGenerateContentResponse` in `@firebase/ai` omits `modelVersion`/`responseId` and stamps `inferenceSource: "in_cloud"`.',
});
