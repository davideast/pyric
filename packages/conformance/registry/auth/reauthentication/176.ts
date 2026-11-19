import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["reauthenticateWithCredential","reauthenticateWithPopup","reauthenticateWithRedirect","updateEmail","updatePassword","deleteUser"],
  api: "reauthenticate* and the `auth/requires-recent-login` gate",
  behavior: "`updatePassword`, `updateEmail`, `verifyBeforeUpdateEmail` and `deleteUser` refuse a non-anonymous session whose last authentication is more than five minutes old with `auth/requires-recent-login` (message `Firebase: Error (auth/requires-recent-login).`). The age is measured on the sandbox clock, so advancing the clock reaches the gate. A sign-in or a successful re-authentication restarts the window; a forced token refresh, a `reload` and a served-session restore do not, and a refreshed token keeps its `auth_time`. Not gated: `updateProfile`, `getIdToken(true)`, `unlink`, and `linkWithCredential` and `deleteUser` on an anonymous account. Enforced in the in-page sandbox and in the served worker's port sessions.",
  status: "conforms",
  evidence: "Oracle capture `auth-requires-recent-login`: deleteUser allowed at ages 280 and 295 seconds and refused at 305 and 320; at 330 seconds updatePassword, verifyBeforeUpdateEmail and deleteUser refused, updateProfile, forced refresh, unlink, anonymous link and anonymous delete allowed; a refresh at 120 seconds left the gate in place at 330; reauthenticateWithCredential cleared it. Replayed against the sandbox in `unit:oracle-conformance.test.ts`; served-worker parity in `unit:auth-requires-recent-login.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["auth-requires-recent-login"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/requires-recent-login.test.ts","packages/cli/test/serve/worker/auth-requires-recent-login.test.ts"],
});
