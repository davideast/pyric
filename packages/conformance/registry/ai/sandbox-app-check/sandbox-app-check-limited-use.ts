import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['getAI'],
  api: 'getAI(app, { useLimitedUseAppCheckTokens: true }) in sandbox AI mode',
  behavior: 'Each request carries a fresh limited-use token rather than the cached one, with a 300 second TTL, and the sandbox answers.',
  evidence: 'capture `app-check-client-ai-header` (`limitedUseModel`).',
  oracleObservations: ['app-check-client-ai-header'],
});
