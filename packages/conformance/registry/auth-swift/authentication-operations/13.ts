import { row } from './section.ts';

export default row({
  order: 80,
  flipped: 'live-host',
  api: 'Auth.restoreSession(uid:)',
  behavior: 'Restores an authenticated session for the given UID via the Pyric bridge.',
  featureKeys: ['restoreSession'],
});
