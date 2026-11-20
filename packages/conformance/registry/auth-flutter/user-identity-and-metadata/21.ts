import { row } from './section.ts';

export default row({
  order: 20,
  api: 'UserPlatform.email',
  behavior: 'Returns primary email address or null for anonymous users.',
  featureKeys: ['email'],
  flipped: 'unit-backed',
});
