import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 20,
  featureKeys: ['functionCall'],
  api: 'toolConfig.functionCallingConfig',
  behavior: 'Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP`',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-function-call-shape` and `ai-sdk-function-calling-roundtrip` (`firstTurnForcedAny.functionCallPartPresent: true`, `finishReason: "STOP"`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `function-calling.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-function-call-shape', 'ai-sdk-function-calling-roundtrip'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'function-calling.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-FNCALL-MODE-ANY',
      observation: 'ai-sdk-function-calling-roundtrip',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'FunctionCallingMode.ANY forces a functionCall part and finishes with STOP.',
    },
  ],
});
