import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled }): AppCheck',
  featureKeys: ['initializeAppCheck', 'AppCheck'],
  behavior: 'Returns an `AppCheck` handle whose `app` is the app it was initialized on.',
  evidence: 'capture `app-check-client-initialize-twice` (`instanceKeySet` includes `app`).',
  observations: ['app-check-client-initialize-twice'],
});
