import { row } from './section.ts';

export default row({
  order: 20,
  api: 'FieldValue.delete()',
  behavior: 'Encodes sentinel that deletes the target field during document update.',
  featureKeys: ['deleteField'],
  flipped: 'unit-backed',
});
