import { row } from './section.ts';

export default row({
  order: 50,
  api: 'Database.goOffline() / goOnline()',
  behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker. goOffline() also turns `.info/connected` false for that database until goOnline().',
  featureKeys: ['goOffline', 'goOnline'],
});
