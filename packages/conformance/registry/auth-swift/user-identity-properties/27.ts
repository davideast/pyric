import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'live-host',
  api: 'User.displayName',
  behavior: 'Returns the user\'s display name if set.',
  featureKeys: ['displayName'],
});
