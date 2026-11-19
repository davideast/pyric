import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["updateCurrentUser"],
  api: "updateCurrentUser(auth, user)",
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Clones `user` onto `auth` (`auth.currentUser !== user`, preserving session lineage) or clears `auth.currentUser` when passed `null`, firing `onAuthStateChanged`; rejects cross-tenant mismatches with `FirebaseError('auth/tenant-id-mismatch')` without mutating `auth.currentUser`, across in-page and served worker planes",
  evidence: "`oracle:auth-updatecurrentuser-set-and-null-signout` (fb-js-sdk 12.19.0); `unit:auth-user-management.test.ts` (in-page + served worker), `unit:fruit-aliases.test.ts`",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `auth/tenant-id-mismatch`"],
  oracleObservations: ["auth-updatecurrentuser-set-and-null-signout"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-management.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-user-management.test.ts","packages/pyric/test/auth/fruit-aliases.test.ts"],
});
