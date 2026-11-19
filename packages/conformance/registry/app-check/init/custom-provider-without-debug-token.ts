import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck), getLimitedUseToken(appCheck) with a CustomProvider and no debug token',
  featureKeys: ['CustomProvider', 'getToken', 'getLimitedUseToken'],
  behavior: 'With `FIREBASE_APPCHECK_DEBUG_TOKEN` neither `true` nor a string, the SDK calls the `CustomProvider` and returns its token as given, caching it until its `expireTimeMillis`, while `getLimitedUseToken` invokes the provider without using the cached token. When the provider rejects, `getToken` and `getLimitedUseToken` reject with its exact error and an `onTokenChanged` error handler receives it.',
  evidence: 'capture `app-check-custom-provider-without-debug-token` (`customTokenCachingAndLimitedUse`, `providerRejection`), replayed in `packages/pyric/test/app-check/oracle-conformance.test.ts`.',
  observations: ['app-check-custom-provider-without-debug-token'],
  notes: 'AI Logic header attachment and placeholder-token refusal on the bridged handle are tracked in the `ai` compatibility registry (`packages/cli/test/serve/ai-app-check-passthrough.test.ts`). The sandbox cannot verify a token Google signed, so AI Logic\'s gate in the sandbox admits only a sandbox-signed token (one `pyric-admin` `createToken` or the sandbox mints). Upstream reads the debug global at the first `initializeAppCheck` in the page; the sandbox reads it at each one. The sandbox has no token refresher: with `isTokenAutoRefreshEnabled: true`, upstream `initializeAppCheck` adds an internal token listener that calls the provider at once, refreshes at the token\'s issue time plus half its TTL plus 5 minutes (no later than 5 minutes before expiry), and retries a failure with backoff from 30 seconds to 16 minutes; the sandbox calls the provider only when a token is requested.',
});
