import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`getIdToken()` after expiry returns a fresh token: a minted token lasts one hour (`exp - iat` is 3600), a non-forced read once the clock passes `exp` minus 30 seconds mints a new token, fires `onIdTokenChanged` but not `onAuthStateChanged`, and rules read the new token, on the in-page, SharedWorker, and Node-hosted planes",
  status: "conforms",
  evidence: "`oracle:auth-getidtoken-expiry-buffer-refresh` (fb-js-sdk 12.19.0 against the oracle project: `exp - iat === 3600`, cached token returned at `expirationTime - 45s` with `0` listener fires, fresh 3600s token carrying updated custom claims minted at `expirationTime - 15s` with `1` `onIdTokenChanged` fire and `0` `onAuthStateChanged` fires); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-anon-cred-expiry.test.ts`, plus `unit:sandbox-token-lifetime.test.ts`, `unit:auth-token-lifetime.test.ts`, and `test/apps/id-token-bearer-header`",
  risk: ["timing", "listener"],
  riskScore: 3,
  riskReasons: ["asserts timing semantics", "asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-getidtoken-expiry-buffer-refresh"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/pyric/test/auth/sandbox-token-lifetime.test.ts",
    "packages/cli/test/serve/worker/auth-token-lifetime.test.ts",
  ],
  conformanceChecks: [
    {
      finding: "AUTH-55A",
      observation: "auth-getidtoken-expiry-buffer-refresh",
      expect: {
        initialExpMinusIatSeconds: 3600,
        beforeRefreshBuffer: {
          returnedCachedToken: true,
          carriesUpdatedClaim: false,
          idTokenChangedFires: 0,
          authStateChangedFires: 0,
        },
        insideRefreshBuffer: {
          mintedFreshToken: true,
          carriesUpdatedClaim: true,
          refreshedExpMinusIatSeconds: 3600,
          idTokenChangedFires: 1,
          authStateChangedFires: 0,
          subsequentReadReturnsNewCachedToken: true,
        },
      },
      probe: "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
      guards: "getIdToken() caches 3600s tokens before expirationTime minus 30s and refreshes non-forced inside the 30s buffer, firing onIdTokenChanged without firing onAuthStateChanged.",
    },
  ],
});
