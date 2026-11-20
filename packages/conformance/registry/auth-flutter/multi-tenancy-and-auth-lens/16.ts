import { row } from './section.ts';

export default row({
  order: 20,
  api: 'PyricAuthCredentialsProvider.authLensChanges',
  behavior: 'Emits distinct AuthLens transitions driving Firestore operation stamping and listener re-subscription.',
  featureKeys: ['authLensChanges'],
  flipped: 'unit-backed',
});
