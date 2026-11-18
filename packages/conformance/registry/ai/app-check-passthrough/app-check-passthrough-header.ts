import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getAI', 'initializeAppCheck'],
  api: 'initializeAppCheck(app) then getAI(app) in production AI mode',
  behavior: 'In production AI mode the app\'s `firebase/app-check` is the Firebase SDK attached to the same app `firebase/ai` uses, so `generateContent` carries `X-Firebase-AppCheck` equal to the token `getToken` returns, and AI Logic answers 200.',
  evidence: 'capture `app-check-client-ai-header` (`appCheckInitialized`), replayed by the AI pass-through suite through the served App Check bridge. On main before the bridge, `firebase/app-check` was swapped to the deferred `pyric/app-check` stub in production AI mode, and the real SDK on the Pyric app failed `appCheck/use-before-activation` because activation and lookup used different app objects.',
  oracleObservations: ['app-check-client-ai-header'],
  notes: 'The returned handle\'s `.app` is the shadow Firebase app (same name and options as the app passed in, a different object); the SDK reads it to find the activation.',
});
