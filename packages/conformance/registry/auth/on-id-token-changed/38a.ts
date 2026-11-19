import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Fires on EVERY sign-in, including a same-uid re-sign-in (no `signOut` first) — which mints a fresh token, so a subsequent `getIdToken()` returns a new string. Mirrors upstream `notifyAuthListeners`, which calls `idTokenSubscription.next` on every identity update (`auth_impl.ts:716`). `onAuthStateChanged` stays silent on the same-uid case (row 30a).",
  evidence: "`oracle:auth-onauthstatechanged-same-uid-dedup-vs-idtoken` (fb-js-sdk 12.19.0); `unit:auth-listeners-and-middleware.test.ts` (in-page + served worker); `unit:sandbox-uid-dedup.test.ts`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  rowNumber: 38,
  oracleObservations: ["auth-onauthstatechanged-same-uid-dedup-vs-idtoken"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-listeners-and-middleware.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-listeners-and-middleware.test.ts","packages/pyric/test/auth/sandbox-uid-dedup.test.ts"],
});
