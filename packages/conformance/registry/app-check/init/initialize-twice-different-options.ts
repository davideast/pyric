import { row } from './section.ts';

export default row({
  order: 30,
  flipped: 'oracle-backed',
  api: 'initializeAppCheck(app, options) called twice',
  featureKeys: ['initializeAppCheck'],
  behavior: 'A second call with a different `isTokenAutoRefreshEnabled` throws a `FirebaseError` with code `appCheck/already-initialized`, `customData.appName` set to the app name, and the message that names `initializeAppCheck()` and the app.',
  evidence: 'capture `app-check-client-initialize-twice` (`differentAutoRefresh`).',
  observations: ['app-check-client-initialize-twice'],
  errorText: true,
});
