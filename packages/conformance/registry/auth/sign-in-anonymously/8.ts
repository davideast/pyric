import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "If an anonymous user is already signed in, returns the SAME user (no fresh uid mint)",
  status: "conforms",
  evidence: "`oracle:auth-anonymous-idempotency-and-remint` (fb-js-sdk 12.19.0 against the oracle project: repeat `signInAnonymously` while signed in preserves `sameUid`, `sameUserRef`, and `currentUserUnchanged` with `operationType: 'signIn'` and `providerId: null`); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-anon-cred-expiry.test.ts` and `unit:sandbox-anonymous.test.ts`",
  automation: "oracle-backed",
  oracleObservations: ["auth-anonymous-idempotency-and-remint"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/pyric/test/auth/sandbox-anonymous.test.ts",
  ],
});
