import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Creates a new user, signs them in automatically (currentUser becomes the new user)",
  evidence: "`oracle:auth-canonical-import-and-createuser-shape` (fb-js-sdk 12.19.0 against the oracle project: `autoSignedInAsCurrentUser: true` and `currentUserUidMatchesCreatedUid: true`); replayed across in-page, SharedWorker, and Node-hosted WebSocket planes by `unit:auth-canonical-import-createuser.test.ts` and `unit:sandbox-email-password.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-canonical-import-and-createuser-shape"],
  conformanceTests: [
    "packages/pyric/test/auth/oracle-captures/auth-canonical-import-createuser.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/auth-canonical-import-createuser.test.ts",
    "packages/pyric/test/auth/sandbox-email-password.test.ts",
  ],
  conformanceChecks: [
    {
      finding: "AUTH-20",
      observation: "auth-canonical-import-and-createuser-shape",
      expect: {
        createUserAutoSignInAndShape: {
          autoSignedInAsCurrentUser: true,
          currentUserUidMatchesCreatedUid: true,
          operationType: "signIn",
          credentialProviderId: null,
          userShape: {
            isAnonymous: false,
            emailMatchesInput: true,
            displayName: null,
            photoURL: null,
            phoneNumber: null,
            emailVerified: false,
            providerIds: ["password"],
          },
        },
      },
      probe: "packages/pyric/test/auth/oracle-captures/auth-canonical-import-createuser.test.ts",
      guards: "createUserWithEmailAndPassword signs the newly created user in automatically as auth.currentUser.",
    },
  ],
});
