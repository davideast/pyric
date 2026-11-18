import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["Schema"],
  api: 'Schema.anyOf()',
  behavior: '`Schema.anyOf` returns an `AnyOfSchema` whose JSON carries an `anyOf` array of sub-schemas and no top-level type',
  automation: 'unit-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I2 empty anyOf → invalid-schema) + `unit:helpers-schema.test.ts` test `ai#schema-anyof`',
  conformanceTests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
});
