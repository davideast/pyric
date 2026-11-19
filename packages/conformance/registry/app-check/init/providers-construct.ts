import { row } from './section.ts';

export default row({
  order: 50,
  flipped: 'oracle-backed',
  api: 'new CustomProvider({ getToken })',
  featureKeys: ['CustomProvider'],
  behavior: 'A `CustomProvider` constructs and is accepted by `initializeAppCheck`. With a debug token in effect, the SDK never calls it (a provider whose `getToken` would reject is called zero times).',
  evidence: 'capture `app-check-client-debug-get-token` (`customProviderCalls`; the capture initialized App Check with a `CustomProvider`).',
  observations: ['app-check-client-debug-get-token'],
});
