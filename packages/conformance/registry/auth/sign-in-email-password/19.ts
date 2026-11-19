import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Password strength requirements — rejects passwords shorter than 6 chars with `auth/weak-password` on `createUserWithEmailAndPassword`. Strength is NOT enforced on `signInWithEmailAndPassword` so previously-seeded weak passwords still let the user in (matches prod's separation of registration vs sign-in).",
  status: "conforms",
  evidence: "`unit:sandbox-email-password.test.ts` + oracle: `packages/conformance/observations/auth/auth-row-19-weak-password-error-code.json` (`code: 'auth/weak-password'`, message `Firebase: Password should be at least 6 characters (auth/weak-password).` against digame-mas, fb-js-sdk 12.19.0; matrix language \"≥6 chars per prod default\" empirically confirmed)",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/weak-password`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-row-19-weak-password-error-code"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
});
