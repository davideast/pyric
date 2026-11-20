import { row } from './section.ts';

export default row({
  order: 50,
  api: 'FirebaseDatabase.goOffline() / goOnline()',
  behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker. goOffline() also turns `.info/connected` false until goOnline().',
  featureKeys: ['goOffline', 'goOnline'],
});
