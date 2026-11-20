import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'live-host',
  api: 'User.uid',
  behavior: 'Returns the unique string identifier for the user account.',
  featureKeys: ['uid'],
});
