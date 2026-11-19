import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Provider-flow sign-ins (popup / redirect / credential) record the flow's `providerId` on the identity in the user DB (upsert for unknown uids; append-if-missing for known ones) and reject disabled accounts with `auth/user-disabled` before any state change",
  status: "conforms",
  evidence: "`oracle:auth-credential-signin-rich-user-and-disabled-guard` (fb-js-sdk 12.19.0 against the oracle project: `providerIds: ['password']`, disabled account rejected with `FirebaseError` `auth/user-disabled`, `currentUserPreservedRef: true`, `authStateTransitionsDuringFailure: 0`); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-anon-cred-expiry.test.ts` and `unit:sandbox-user-admin.test.ts`",
  risk: ["specific-value", "error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)", "asserts Firebase error code(s): `auth/user-disabled`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-credential-signin-rich-user-and-disabled-guard"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-anon-cred-expiry.test.ts",
    "packages/pyric/test/auth/sandbox-user-admin.test.ts",
  ],
  conformanceChecks: [
    {
      finding: "AUTH-70",
      observation: "auth-credential-signin-rich-user-and-disabled-guard",
      expect: {
        disabledCredentialSignInWhileSignedIn: {
          attempt: {
            threw: true,
            errorName: "FirebaseError",
            isFirebaseError: true,
            code: "auth/user-disabled",
          },
          currentUserPreservedRef: true,
          currentUserPreservedUid: true,
          authStateTransitionsDuringFailure: 0,
        },
        disabledCredentialSignInWhenSignedOut: {
          attempt: {
            threw: true,
            errorName: "FirebaseError",
            isFirebaseError: true,
            code: "auth/user-disabled",
          },
          currentUserStaysNull: true,
        },
      },
      probe: "packages/pyric/test/auth/oracle-captures/auth-anon-cred-expiry.test.ts",
      guards: "signInWithCredential rejects disabled accounts with auth/user-disabled without mutating currentUser or firing onAuthStateChanged.",
    },
  ],
});
