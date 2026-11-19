import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAdditionalUserInfo"],
  api: "getAdditionalUserInfo(userCredential)",
  behavior: "Returns `{ isNewUser, profile, providerId }`. For a fresh anonymous sign-in prod reports `{ isNewUser: true, providerId: null, profile: {} }`. For `createUserWithEmailAndPassword` and a returning `signInWithEmailAndPassword`, `getAdditionalUserInfo().providerId` is `'password'` (while `UserCredential.providerId` stays null, AUTH-B2). `isNewUser` is `true` for `createUserWithEmailAndPassword`, a first-time email-link sign-in, a custom-token sign-in that minted the account, and linking an email credential onto an anonymous user (auth#160); `false` for a returning `signInWithEmailAndPassword` and for `reauthenticate`.",
  status: "diverged-documented",
  evidence: "Oracle `auth-additional-user-info-shape`. Divergence (#1699): the sandbox reports `providerId: null` for the email create and sign-in arms. The replay pins both. Other arms are unit-backed.",
  risk: ["specific-field","specific-value"],
  riskScore: 5,
  riskReasons: ["asserts `providerId` is null (not 'anonymous') for anonymous sign-in","asserts isNewUser per flow"],
  automation: "oracle-backed",
  oracleObservations: ["auth-additional-user-info-shape"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts","packages/pyric/test/auth/sandbox-linking-reauth.test.ts","packages/pyric/test/auth/upstream-auth-probes.test.ts"],
});
