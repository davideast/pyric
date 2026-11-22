import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["initializeAuth"],
  api: "initializeAuth(app, deps?)",
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Shares the `getAuth(app)` `Auth` handle per app, applies `deps.persistence` (single `Persistence` or `Persistence[]` hierarchy, defaulting to in-memory when omitted or empty), and tracks initial `Dependencies` (`deps ?? {}`, matching `@firebase/auth`): repeated `initializeAuth(app, deps)` with matching options (or `initializeAuth(app)` after `getAuth(app)`) returns the cached handle, while re-calling `initializeAuth` with different options (including `initializeAuth(app)` after `initializeAuth(app, deps)` or `initializeAuth(app, deps)` after `getAuth(app)`) throws `FirebaseError('auth/already-initialized')` across in-page and served worker planes",
  evidence: "`oracle:auth-initializeauth-lifecycle-and-deps` (fb-js-sdk 12.19.0); `unit:auth-user-management.test.ts` (in-page + served worker), `unit:persistence-options.test.ts`, `unit:auth-core-parity-pr1.test.ts`, `unit:fruit-aliases.test.ts`",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `auth/already-initialized`"],
  oracleObservations: ["auth-initializeauth-lifecycle-and-deps"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-user-management.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-user-management.test.ts","packages/pyric/test/auth/sandbox/persistence-options.test.ts","packages/cli/test/serve/worker/auth-core-parity-pr1.test.ts","packages/pyric/test/auth/fruit-aliases.test.ts"],
});
