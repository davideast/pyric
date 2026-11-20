import { row } from './section.ts';

export default row({
  order: 30,
  api: 'UserPlatform.displayName',
  behavior: 'Returns profile display name string or null if unset.',
  featureKeys: ['displayName'],
  flipped: 'unit-backed',
});
