import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/schema-builders-oracle.test.ts';

export default row({
  order: 10,
  featureKeys: ['Schema'],
  api: 'Schema.object()',
  behavior:
    '`Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties`',
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
      finding: 'AI-SCHEMA-OBJECT',
      observation: 'ai-offline-schema-builders-and-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'Schema.object derives required from optionalProperties and preserves propertyOrdering.',
    },
  ],
});
