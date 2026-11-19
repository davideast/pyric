import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "The credential's rich `User` (email / displayName / isAnonymous) survives the transition - popup/redirect/credential/`setUser` do NOT clobber it down to the bare `AuthState`; `cred.user === auth.currentUser` (reference identity, matches upstream `_updateCurrentUser(userCredential.user)`)",
  status: "conforms",
  evidence: "`oracle:auth-credential-signin-rich-user-and-disabled-guard` (fb-js-sdk 12.19.0 against the oracle project: `credUserSameRefAsCurrentUser: true`, seeded `displayName`, `photoURL`, `emailVerified`, and `providerIds: ['password']` preserved); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-anon-cred-expiry.test.ts` and `unit:sandbox-user-identity.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-credential-signin-rich-user-and-disabled-guard"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/pyric/test/auth/sandbox-user-identity.test.ts",
  ],
  rowNumber: 47,
});
