import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FieldValue.delete()',
  behavior: 'Sentinel deleting target field during document update operation.',
  featureKeys: ['deleteField'],
  flipped: 'unit-backed',
});
