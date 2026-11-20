import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FirebaseAuthPlatform.sendAuthChangesEvent(appName, userPlatform)',
  behavior: 'Dispatches synthetic auth state updates across all stream controllers.',
  featureKeys: ['sendAuthChangesEvent'],
  flipped: 'unit-backed',
});
