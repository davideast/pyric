import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Schema"],
  api: 'Schema.object()',
  behavior: '`Schema.object` serializes to type `object` with `properties`, and `required` is derived by excluding `optionalProperties`',
  automation: 'unit-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I2 empty optionalProperties + propertyOrdering) + `unit:helpers-schema.test.ts` test `ai#schema-object-tojson`',
  conformanceTests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
});
