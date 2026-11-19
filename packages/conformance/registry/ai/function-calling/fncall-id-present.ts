import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/wave2-sdk-oracle.test.ts';

export default row({
  order: 30,
  featureKeys: ['functionCall'],
  api: 'functionCall parts',
  behavior: '`functionCall.id` is present on the GoogleAI wire; the mirror emits an id on synthesized calls',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-function-call-shape` and `ai-sdk-function-calling-roundtrip` (`functionCallIdIsNonEmptyString: true`) replayed across in-process (`wave2-sdk-oracle.test.ts`, `function-calling.test.ts`), worker-host (`ai-wave2-sdk-oracle.test.ts`), and served SharedWorker (`test/apps/ai-app-check-stays-local`) planes.',
  oracleObservations: ['ai-function-call-shape', 'ai-sdk-function-calling-roundtrip'],
  conformanceTests: ['wave2-sdk-oracle.test.ts', 'function-calling.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-wave2-sdk-oracle.test.ts',
    'test/apps/ai-app-check-stays-local/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-FNCALL-ID-PRESENT',
      observation: 'ai-sdk-function-calling-roundtrip',
      expect: { model: 'gemini-flash-lite-latest' },
      probe: PROBE,
      guards: 'Synthesized and wire functionCall parts carry a non-empty string id.',
    },
  ],
  notes: 'The upstream JSDoc is self-contradictory about backend id support; the capture is the fact.',
});
