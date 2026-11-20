import { row } from './section.ts';

export default row({
  order: 10,
  api: 'UserPlatform.uid',
  behavior: 'Returns unique identifier string for the authenticated user.',
  featureKeys: ['uid'],
  flipped: 'unit-backed',
});
