import { row } from './section.ts';

export default row({
  order: 60,
  flipped: 'oracle-backed',
  api: 'getToken(appCheck), getLimitedUseToken(appCheck) with a CustomProvider and no debug token',
  featureKeys: ['CustomProvider', 'getToken', 'getLimitedUseToken'],
  behavior: 'With `FIREBASE_APPCHECK_DEBUG_TOKEN` neither `true` nor a string, the SDK calls the `CustomProvider` and returns its token as given, caching it until its `expireTimeMillis`, while `getLimitedUseToken` invokes the provider without using the cached token. When the provider rejects, `getToken` and `getLimitedUseToken` reject with its exact error and an `onTokenChanged` error handler receives it.',
  evidence: 'capture `app-check-custom-provider-without-debug-token` (`customTokenCachingAndLimitedUse`, `providerRejection`), replayed in `packages/pyric/test/app-check/oracle-conformance.test.ts`.',
  observations: ['app-check-custom-provider-without-debug-token'],
  notes: 'AI Logic header attachment and placeholder-token refusal on the bridged handle are tracked in the `ai` compatibility registry (`packages/cli/test/serve/ai-app-check-passthrough.test.ts`). The sandbox cannot verify a token Google signed, so AI Logic\'s gate in the sandbox admits only a sandbox-signed token (one `pyric-admin` `createToken` or the sandbox mints) whose audience matches the app project and subject matches `appId`. Upstream reads the debug global at the first `initializeAppCheck` in the page; the sandbox reads it at each one. With `isTokenAutoRefreshEnabled: true`, the sandbox mirrors upstream\'s proactive token refresher: it calls the provider immediately, refreshes at `issuedAt + 0.5 * ttl + 5m` (no later than 5 minutes before expiry), and retries rejections with exponential backoff from 30 seconds to 16 minutes.',
});
