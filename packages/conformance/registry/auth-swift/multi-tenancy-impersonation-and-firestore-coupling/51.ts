import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'unit-backed',
  api: 'FirebaseAuthBootstrap.initialize()',
  behavior: 'Registers Auth as the Firestore AuthCredentialProvider factory.',
  featureKeys: ['authCredentialProvider'],
});
