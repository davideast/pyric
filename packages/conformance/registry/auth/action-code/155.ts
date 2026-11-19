import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["sendPasswordResetEmail"],
  api: "sendPasswordResetEmail(auth, email)",
  behavior: "For an address NO account owns, prod RESOLVES silently: it does not throw `auth/user-not-found`. Email Enumeration Protection is on by default and refusing to leak account existence is the point. The sandbox matches: it resolves and mails nothing. A malformed address still throws `auth/invalid-email`. For a real account, the sandbox mails a reset code; `confirmPasswordReset` redeems it and the new password signs in while the old one throws `auth/invalid-credential`.",
  status: "conforms",
  evidence: "ORACLE-BACKED on the enumeration-protection behavior — the fact most likely to be got wrong: `auth-sendpasswordresetemail-unknown-user` captured `resolvedForUnknownUser: true`, `unknownUserCode: null`, `malformedEmailCode: auth/invalid-email`. A shim that threw `auth/user-not-found` here would hand agent code an account oracle production deliberately removed. Reset round trip unit-backed in `unit:sandbox-email-link.test.ts`.",
  risk: ["error-code","specific-value"],
  riskScore: 5,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-email`","asserts prod does NOT throw for an unknown account"],
  automation: "oracle-backed",
  oracleObservations: ["auth-sendpasswordresetemail-unknown-user"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
