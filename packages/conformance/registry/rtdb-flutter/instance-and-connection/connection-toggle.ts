import { row } from './section.ts';

export default row({
  order: 50,
  api: 'PyricDatabase.goOffline() / goOnline()',
  behavior: 'Suspends and resumes the Realtime Database connection to the Pyric worker; `.info/connected` reports false after goOffline() and true again after goOnline() once the bridge is attached.',
  featureKeys: ['goOffline', 'goOnline'],
});
