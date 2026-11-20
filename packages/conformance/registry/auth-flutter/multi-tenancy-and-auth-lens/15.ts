import { row } from './section.ts';

export default row({
  order: 10,
  api: 'PyricAuthCredentialsProvider.currentAuthLens',
  behavior: 'Derives active AuthLens (asUser with uid, tenant, and custom claims, or anon).',
  featureKeys: ['currentAuthLens'],
  flipped: 'unit-backed',
});
