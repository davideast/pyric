import { row } from './section.ts';

export default row({
  order: 20,
  flipped: 'unit-backed',
  api: 'User.getIDToken(forcingRefresh:completion:)',
  behavior: 'Retrieves the Firebase Auth ID token string using a completion closure.',
  featureKeys: ['getIdToken'],
});
