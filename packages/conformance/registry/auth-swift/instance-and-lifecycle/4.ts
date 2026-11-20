import { row } from './section.ts';

export default row({
  order: 40,
  flipped: 'live-host',
  api: 'Auth.app',
  behavior: 'Returns the FirebaseApp instance associated with this Auth instance.',
  featureKeys: ['app'],
});
