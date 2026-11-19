import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`getIdToken()` after expiry returns a fresh token: a minted token lasts one hour (`exp - iat` is 3600), a non-forced read once the clock passes `exp` minus 30 seconds mints a new token, fires `onIdTokenChanged` but not `onAuthStateChanged`, and rules read the new token, on the in-page and worker planes",
  status: "unverified",
  evidence: "Upstream source: `StsTokenManager.isExpired` in `@firebase/auth` 1.13.6 (`Date.now() > expirationTime - 30000`, `TOKEN_REFRESH_BUFFER_MS`), and `exp - iat` of 3600 in `oracle:auth-request-auth-per-sign-in` (row 68c). Pyric: `unit:sandbox-token-lifetime.test.ts` (in-page) and `unit:auth-token-lifetime.test.ts` (worker port) move the sandbox clock past the refresh point; the app scenario `test/apps/id-token-bearer-header` moves it 61 minutes with `pyric sandbox advanceClock` and verifies the page's next token with firebase-admin. A production observation of a read after expiry is still needed",
  risk: ["timing", "listener"],
  riskScore: 3,
  riskReasons: ["asserts timing semantics", "asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-token-lifetime.test.ts", "packages/cli/test/serve/worker/auth-token-lifetime.test.ts"],
});
