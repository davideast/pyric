import { row } from './section.ts';

export default row({
  order: 100,
  api: 'UserPlatform.metadata',
  behavior: 'Provides creationTimestamp and lastSignInTimestamp wrapped in UserMetadata.',
  featureKeys: ['metadata'],
  flipped: 'unit-backed',
});
