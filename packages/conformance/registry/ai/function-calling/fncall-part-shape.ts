import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 10,
  featureKeys: ['functionCall'],
  api: 'functionCall parts',
  behavior:
    'A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-function-call-shape` and `ai-sdk-function-calling-roundtrip` (`functionCallKeySet: ["args", "id", "name"]`, `argsIsPlainObject: true`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `function-calling.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-function-call-shape', 'ai-sdk-function-calling-roundtrip'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'function-calling.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-FNCALL-PART-SHAPE',
      observation: 'ai-sdk-function-calling-roundtrip',
      expect: {
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
      },
      probe: PROBE,
      guards: 'functionCall parts carry args, id, and name with args parsed as a plain object.',
    },
  ],
  notes: 'The parsed-object args shape is the load-bearing difference from OpenAI tool_calls.',
});
