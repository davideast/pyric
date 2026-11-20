import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'unit-backed',
  api: 'Auth.reset()',
  behavior: 'Resets cached Auth instances across all FirebaseApp instances.',
  featureKeys: ['reset'],
});
