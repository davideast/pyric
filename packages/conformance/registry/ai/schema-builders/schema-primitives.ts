import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["Schema"],
  api: 'Schema.string()/integer()/number()/boolean()/array()',
  behavior: 'Each primitive builder serializes its `SchemaType`, and `array` carries `items`',
  automation: 'unit-backed',
  evidence: '`unit:helpers-schema.test.ts` test `ai#schema-primitives` (upstream toJSON request shape)',
  conformanceTests: ['helpers-schema.test.ts'],
});
