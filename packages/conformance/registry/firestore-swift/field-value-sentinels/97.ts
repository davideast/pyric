import { row } from './section.ts';

export default row({
  order: 60,
  api: 'FieldValue.vector(_:)',
  behavior: 'Constructs dense vector embedding from Double or Float array.',
  featureKeys: ['vector'],
  flipped: 'unit-backed',
});
