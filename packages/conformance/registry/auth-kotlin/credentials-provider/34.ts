import { row } from './section.ts';

export default row({
  order: 20,
  api: 'CredentialsProvider.authLensFlow',
  behavior: 'Emits updated AuthLens on authentication state transitions (sign-in, sign-out, token refresh, tenant change).',
  featureKeys: ['authLensFlow'],
  flipped: 'live-host',
});
