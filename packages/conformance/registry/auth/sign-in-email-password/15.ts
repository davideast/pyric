import { row } from './section.ts';

export default row({
  order: 30,
  status: "conforms",
  automation: "oracle-backed",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  behavior: "Throws `auth/invalid-credential` when signing in with a password that does not match the stored account (matching Firebase's default Email Enumeration Protection across in-page, SharedWorker, and Node-hosted planes)",
  evidence: "`unit:oracle-conformance.test.ts`, `unit:sandbox-email-password.test.ts`, `unit:multi-tenant-auth-backend-parity.test.ts`, `test/apps/served-credential-sign-in-checks-secret` + oracle: `packages/conformance/observations/auth/auth-wrong-password-error-code.json` (`code: 'auth/invalid-credential'` against the oracle project, fb-js-sdk 12.19.0)",
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/invalid-credential`","asserts a specific field/property value"],
  oracleObservations: ["auth-wrong-password-error-code"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-password.test.ts","packages/cli/test/serve/worker/multi-tenant-auth-backend-parity.test.ts"],
  conformanceChecks: [{"finding":"AUTH-15","observation":"auth-wrong-password-error-code","expect":{"code":"auth/invalid-credential"},"probe":"packages/pyric/test/auth/oracle-conformance.test.ts","guards":"signInWithEmailAndPassword throws auth/invalid-credential for a wrong password under Email Enumeration Protection."}],
});
