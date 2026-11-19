import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["updatePassword"],
  api: "updatePassword(user, newPassword)",
  behavior: "Sets the stored password (validated for strength). The sandbox DOES store and verify passwords, so this is a real mutation: a subsequent `signInWithEmailAndPassword` with the new password succeeds and the old one throws `auth/invalid-credential`. A session older than five minutes is refused with `auth/requires-recent-login` until it signs in again or re-authenticates. The change revokes the account's other sessions, whose next refresh rejects `auth/user-token-expired` and signs out (other browsers and other worker ports included), while the session that changed it keeps refreshing, after a page reload too; an admin password change (`sandbox.updateUser`, `pyric auth updateUser --password`) revokes every session (#1950)",
  status: "conforms",
  evidence: "`unit:fruit-aliases.test.ts`: new password signs in, old password throws `auth/invalid-credential`. Revocation: `unit:sandbox-user-admin.test.ts` (\"an admin password change refuses the held session refresh and signs out\", \"the session that changes its own password keeps refreshing\"). Recent-login gate: oracle capture `auth-requires-recent-login` (refused at 330 seconds, allowed right after sign-in and after reauthentication), replayed in `unit:oracle-conformance.test.ts`",
  automation: "oracle-backed",
  risk: ["error-code"],
  riskScore: 2,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-credential`, `auth/requires-recent-login`"],
  oracleObservations: ["auth-requires-recent-login"],
  conformanceTests: ["packages/pyric/test/auth/fruit-aliases.test.ts","packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/requires-recent-login.test.ts"],
});
