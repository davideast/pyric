import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["deleteUser"],
  api: "deleteUser(user)",
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Deletes the account from the user store AND signs the user out if they are current (`auth.currentUser` becomes `null` and `onAuthStateChanged(null)` fires). Subsequent `reload(user)` rejects with `auth/user-token-expired` on both in-page and served worker planes; subsequent `signInWithEmailAndPassword` rejects with `auth/invalid-credential` across planes (`auth#14`). A non-anonymous session older than five minutes is refused with `auth/requires-recent-login` (`oracle:auth-requires-recent-login`)",
  evidence: "`oracle:auth-deleteuser-signout-and-followup-errors` (fb-js-sdk 12.19.0); `unit:auth-user-management.test.ts` (in-page + served worker), `unit:fruit-aliases.test.ts`, `unit:upstream-auth-probes.test.ts`",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-credential`, `auth/user-token-expired`"],
  oracleObservations: ["auth-deleteuser-signout-and-followup-errors"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-management.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-user-management.test.ts","packages/pyric/test/auth/fruit-aliases.test.ts","packages/pyric/test/auth/upstream-auth-probes.test.ts"],
});
