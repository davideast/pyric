import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "After `signOut`, a subsequent `signInAnonymously` mints a fresh uid",
  status: "conforms",
  evidence: "`oracle:auth-anonymous-idempotency-and-remint` (fb-js-sdk 12.19.0 against the oracle project: `currentUserNullAfterSignOut: true` and `mintedFreshUid: true` after `signOut`); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-anon-cred-expiry.test.ts` and `unit:sandbox-anonymous.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-anonymous-idempotency-and-remint"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/pyric/test/auth/sandbox-anonymous.test.ts",
  ],
});
