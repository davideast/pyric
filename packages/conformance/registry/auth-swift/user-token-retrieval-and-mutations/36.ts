import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'unit-backed',
  api: 'User.getIDToken(forcingRefresh:)',
  behavior: 'Retrieves the Firebase Auth ID token string asynchronously, optionally forcing a refresh.',
  featureKeys: ['getIdToken'],
});
