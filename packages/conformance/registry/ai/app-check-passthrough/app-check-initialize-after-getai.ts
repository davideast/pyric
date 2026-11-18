import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['getAI', 'initializeAppCheck'],
  api: 'initializeAppCheck(app) after getAI(app)',
  behavior: 'Calling `initializeAppCheck` after `getAI(app)` built a model does not throw and `getToken` works, but that model sends no `X-Firebase-AppCheck` header, so AI Logic treats it as a request with no token (row `ai#app-check-required`). App Check must be initialized before `getAI`.',
  evidence: 'capture `app-check-client-get-token-before-initialize` (`initializeAfterAi`, `getTokenAfterLateInitialize`, `aiRequestAfterLateInitialize`, and `aiGenerationAfterLateInitialize` for the refused generation, 401 while enforcement was `ENFORCED`).',
  oracleObservations: ['app-check-client-get-token-before-initialize'],
});
