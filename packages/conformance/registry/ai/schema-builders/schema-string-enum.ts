import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["Schema"],
  api: 'Schema.enumString()',
  behavior: '`Schema.enumString` serializes the enum values with type `string` and format `enum`',
  status: 'diverged-documented',
  statusNote: 'format',
  automation: 'unit-backed',
  evidence: '`unit:helpers-schema.test.ts` test `ai#schema-string-enum` (upstream toJSON request shape; GoogleAI accepts only enum and date-time formats)',
  conformanceTests: ['helpers-schema.test.ts'],
  notes: 'Pinned delta vs installed 2.12.0: the installed enumString omits `format`; GoogleAI accepts only the enum and date-time formats, so the mirror serializes format `enum` (packages/pyric/src/ai/schema.ts).',
});
