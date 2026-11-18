import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['getAI'],
  api: 'getAI(app, { useLimitedUseAppCheckTokens: true }) in production AI mode',
  behavior: 'With `useLimitedUseAppCheckTokens`, each request carries a fresh limited-use token rather than the cached one, and AI Logic answers 200.',
  evidence: 'capture `app-check-client-ai-header` (`limitedUseModel`).',
  oracleObservations: ['app-check-client-ai-header'],
});
