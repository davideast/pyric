import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['functionCall'],
  api: 'functionResponse round trip',
  behavior:
    'A round trip that threads the model functionCall turn back verbatim, thoughtSignature preserved, is accepted: the answer has a text part and no further functionCall part',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-function-response-round` and `ai-sdk-function-calling-roundtrip` (`threadedModelTurnPreservedThoughtSignature: true`, `answerHasTextPart: true`, `answerHasFunctionCallPart: false`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `function-calling.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-function-response-round', 'ai-sdk-function-calling-roundtrip'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'function-calling.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-FNCALL-ROUND-TRIP',
      observation: 'ai-sdk-function-calling-roundtrip',
      expect: {
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
      },
      probe: PROBE,
      guards: 'Round-trip functionResponse with preserved model thoughtSignature resolves to a text answer with no further functionCall.',
    },
  ],
});
