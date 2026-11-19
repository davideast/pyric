import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/schema-builders-oracle.test.ts';

export default row({
  order: 30,
  featureKeys: ['Schema'],
  api: 'Schema.string()/integer()/number()/boolean()/array()',
  behavior: 'Each primitive builder serializes its `SchemaType`, and `array` carries `items`',
  automation: 'oracle-backed',
  evidence:
    'Capture `ai-offline-schema-builders-and-guards` replayed across in-process (`schema-builders-oracle.test.ts`), worker-host (`ai-schema-builders.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-offline-schema-builders-and-guards'],
  conformanceTests: ['schema-builders-oracle.test.ts', 'helpers-schema.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-schema-builders.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-SCHEMA-PRIMITIVES',
      observation: 'ai-offline-schema-builders-and-guards',
      expect: {
        fetchCalls: 0,
        schemaTypes: {
          STRING: 'string',
          NUMBER: 'number',
          INTEGER: 'integer',
          BOOLEAN: 'boolean',
          ARRAY: 'array',
          OBJECT: 'object',
        },
      },
      probe: PROBE,
      guards: 'Primitive and array Schema builders serialize SchemaType, nullable defaults, and array items.',
    },
  ],
});
