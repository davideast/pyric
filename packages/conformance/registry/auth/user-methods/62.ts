import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["updateProfile"],
  api: "updateProfile(user, {displayName, photoURL})",
  behavior: "`updateProfile(user, {displayName, photoURL})` mutates the held user + stored record in place (`undefined` and `null` leave existing fields intact on `/v1/accounts:update`; `\"\"` clears to `null`) without an extra `onAuthStateChanged` or `onIdTokenChanged` fire. Profile survives `signOut` -> `signInWithEmailAndPassword`.",
  status: "conforms",
  evidence: "`oracle:auth-updateprofile-in-place-and-persistence` (fb-js-sdk 12.19.0: in-place `User` + `'password'` `providerData` mutation, `null` leaves existing attribute intact, `0` extra `onAuthStateChanged`/`onIdTokenChanged` fires, survives `signOut` -> `signInWithEmailAndPassword`); `unit:auth-user-methods.test.ts` (in-page + served worker); `unit:sandbox-update-profile.test.ts`",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-updateprofile-in-place-and-persistence"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-methods.test.ts", "packages/cli/test/serve/worker/oracle-captures/auth-user-methods.test.ts", "packages/pyric/test/auth/sandbox-update-profile.test.ts", "packages/pyric/test/auth/upstream-auth-probes.test.ts"],
});
