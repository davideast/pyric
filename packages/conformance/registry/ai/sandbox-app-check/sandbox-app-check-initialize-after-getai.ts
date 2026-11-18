import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getAI', 'initializeAppCheck'],
  api: 'initializeAppCheck(app) after getAI(app) in sandbox AI mode',
  behavior: '`getAI(app)` reads App Check when it builds the handle. `initializeAppCheck` after it does not throw and `getToken` works, but that handle\'s requests carry no token and are refused with the 401.',
  evidence: 'capture `app-check-client-get-token-before-initialize` (`initializeAfterAi`, `getTokenAfterLateInitialize`, `aiRequestAfterLateInitialize`, and `aiGenerationAfterLateInitialize` for the refused generation, 401 while enforcement was `ENFORCED`).',
  oracleObservations: ['app-check-client-get-token-before-initialize'],
});
