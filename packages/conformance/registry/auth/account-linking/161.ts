import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["linkWithCredential"],
  api: "linkWithCredential — conflict codes",
  behavior: "`auth/provider-already-linked` when the account already carries the provider (one identity per provider). `auth/email-already-in-use` when the email credential belongs to a DIFFERENT account — an address can back only one identity, so the link cannot be granted without stealing it.",
  evidence: "ORACLE-BACKED: `auth-link-conflicts`, in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on), captured `auth/provider-already-linked` for a second email credential on an account that already has one, and `auth/email-already-in-use` for an email credential another account owns. Replayed in `unit:oracle-conformance.test.ts` and proven in `unit:sandbox-linking-reauth.test.ts`. `credential-already-in-use` remains the OAuth-credential case.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/provider-already-linked`, `auth/email-already-in-use`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-link-conflicts"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
});
