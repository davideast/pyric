import { row } from './section.ts';

export default row({
  order: 10,
  api: 'FirebaseUser.uid',
  behavior: 'Returns the non-null string uniquely identifying the user across providers.',
  featureKeys: ['uid'],
  flipped: 'live-host',
});
