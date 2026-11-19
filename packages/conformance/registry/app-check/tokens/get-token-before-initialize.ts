import { row } from './section.ts';

export default row({
  order: 10,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck) on an app without initializeAppCheck',
  featureKeys: ['getToken'],
  behavior: 'Rejects with a `FirebaseError` with code `appCheck/use-before-activation`, `customData.appName`, and the message telling the caller to call `initializeAppCheck()` first.',
  evidence: 'capture `app-check-client-get-token-before-initialize` (`publicGetTokenWithUninitializedApp`).',
  observations: ['app-check-client-get-token-before-initialize'],
  errorText: true,
});
