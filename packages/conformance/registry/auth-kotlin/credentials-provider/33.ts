import { row } from './section.ts';

export default row({
  order: 10,
  api: 'CredentialsProvider.getEffectiveLens()',
  behavior: 'Provides AuthLens.Anon when signed out, and AuthLens.AsUser with uid, claims, and tenant when signed in.',
  featureKeys: ['credentialsProvider', 'getEffectiveLens'],
  flipped: 'unit-backed',
});
