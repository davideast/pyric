import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/schema-builders-oracle.test.ts';

export default row({
  order: 40,
  featureKeys: ['Schema'],
  api: 'Schema.anyOf()',
  behavior:
    '`Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-schema-builders-and-guards` replayed across in-process (`schema-builders-oracle.test.ts`), worker-host (`ai-schema-builders.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-schema-builders-and-guards'],
  conformanceTests: ['schema-builders-oracle.test.ts', 'upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-schema-builders.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-SCHEMA-ANYOF',
      observation: 'ai-offline-schema-builders-and-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'Schema.anyOf omits top-level type and throws AIError (invalid-schema) on an empty anyOf array.',
    },
  ],
});
