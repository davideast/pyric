import { row } from './section.ts';

export default row({
  order: 20,
  status: "conforms",
  automation: "oracle-backed",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  behavior: "Throws `auth/invalid-credential` when signing in with an email address no account holds (matching Firebase's default Email Enumeration Protection across in-page, SharedWorker, and Node-hosted planes)",
  evidence: "`unit:oracle-conformance.test.ts`, `unit:sandbox-email-password.test.ts`, `unit:multi-tenant-auth-backend-parity.test.ts`, `test/apps/served-credential-sign-in-checks-secret` + oracle: `packages/conformance/observations/auth/auth-user-not-found-error-code.json` (`code: 'auth/invalid-credential'` against the oracle project, fb-js-sdk 12.19.0)",
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/invalid-credential`"],
  oracleObservations: ["auth-user-not-found-error-code"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-password.test.ts","packages/cli/test/serve/worker/multi-tenant-auth-backend-parity.test.ts"],
  conformanceChecks: [{"finding":"AUTH-14","observation":"auth-user-not-found-error-code","expect":{"code":"auth/invalid-credential"},"probe":"packages/pyric/test/auth/oracle-conformance.test.ts","guards":"signInWithEmailAndPassword throws auth/invalid-credential for an unknown email under Email Enumeration Protection."}],
});
