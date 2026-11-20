import { row } from './section.ts';

export default row({
  order: 90,
  flipped: 'unit-backed',
  api: 'Auth.idTokenChanges',
  behavior: 'Exposes an AsyncSequence for modern async/await iteration over ID token transitions.',
  featureKeys: ['idTokenChanges'],
});
