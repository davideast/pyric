import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/schema-builders-oracle.test.ts';

export default row({
  order: 20,
  featureKeys: ['Schema'],
  api: 'Schema.enumString()',
  behavior: '`Schema.enumString` serializes the enum values with type `string` and format `enum`',
  status: 'diverged-documented',
  statusNote: 'format',
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
      finding: 'AI-SCHEMA-ENUM',
      observation: 'ai-offline-schema-builders-and-guards',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards: 'Schema.enumString preserves enum values while setting format enum over upstream format-less JSON.',
    },
  ],
  notes:
    'Pinned delta vs installed 2.12.0 and 2.16.0 (`firebase` 12.19.0): upstream `enumString` omits `format`, whereas GoogleAI accepts only the `enum` and `date-time` formats, so the mirror serializes `format: "enum"` (`packages/pyric/src/ai/schema.ts`).',
});
