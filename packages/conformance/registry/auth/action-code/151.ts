import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["isSignInWithEmailLink"],
  api: "isSignInWithEmailLink(auth, link)",
  behavior: "Pure predicate over the link string — no network. `true` only for a link whose mode is `signIn` AND which carries an `oobCode`; `false` for a password-reset link, for `mode=signIn` with no code, for garbage, and for the empty string. Never throws.",
  status: "conforms",
  evidence: "ORACLE-BACKED, project-independent (no server involved): `auth-issigninwithemaillink-predicate` captured all five cases against prod. Replayed in `unit:oracle-conformance.test.ts`.",
  risk: ["specific-value"],
  riskScore: 3,
  riskReasons: ["asserts 5 specific predicate outcomes"],
  automation: "oracle-backed",
  oracleObservations: ["auth-issigninwithemaillink-predicate"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
