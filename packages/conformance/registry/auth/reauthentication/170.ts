import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["reauthenticateWithCredential"],
  api: "reauthenticateWithCredential(user, credential)",
  behavior: "A wrong password throws `auth/invalid-credential` (matching Firebase's default Email Enumeration Protection across in-page, SharedWorker, and Node-hosted planes). A credential for a DIFFERENT account throws `auth/user-mismatch`, checked before the password. On success a fresh ID token is minted, and the `UserCredential` carries `operationType: 'reauthenticate'`.",
  status: "conforms",
  evidence: "Oracle `auth-reauthenticate-with-credential` (fb-js-sdk 12.19.0) replayed in `unit:oracle-conformance.test.ts` + `unit:sandbox-linking-reauth.test.ts` + served worker/Node host `e2e:served-auth-reauthentication.pw.ts`.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-credential`, `auth/user-mismatch`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-reauthenticate-with-credential"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
  conformanceChecks: [{"finding":"AUTH-170","observation":"auth-reauthenticate-with-credential","expect":{"wrongPasswordCode":"auth/invalid-credential","userMismatchCode":"auth/user-mismatch"},"probe":"packages/pyric/test/auth/oracle-conformance.test.ts","guards":"reauthenticateWithCredential rejects wrong password with auth/invalid-credential and wrong account with auth/user-mismatch."}],
});
