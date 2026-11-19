import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["reload"],
  api: "reload(user)",
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Re-reads the stored record into the `user` object in place, so out-of-band updates (`displayName`, `photoURL`, `emailVerified`) are reflected on the held reference. If the identity is absent from the store (including after `deleteUser` or admin deletion), rejects with `auth/user-token-expired`; a disabled account rejects with `auth/user-disabled`. Either rejection clears `auth.currentUser` and fires `onAuthStateChanged(null)` across in-page and served worker planes (#1950)",
  evidence: "`oracle:auth-reload-out-of-band-and-disabled-deleted` (fb-js-sdk 12.19.0: in-place refresh + `auth/user-disabled` and `auth/user-token-expired` sign-out); `unit:auth-user-management.test.ts` (in-page + served worker), `unit:fruit-aliases.test.ts`, `unit:upstream-auth-probes.test.ts`",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `auth/user-disabled`, `auth/user-token-expired`"],
  oracleObservations: ["auth-reload-out-of-band-and-disabled-deleted"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-management.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-user-management.test.ts","packages/pyric/test/auth/fruit-aliases.test.ts","packages/pyric/test/auth/upstream-auth-probes.test.ts"],
});
