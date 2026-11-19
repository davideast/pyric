import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["signInWithEmailLink"],
  api: "signInWithEmailLink(auth, email, link)",
  behavior: "Redeems the code in a sign-in link. A link carrying no `oobCode` throws `auth/argument-error` CLIENT-side (the SDK never reaches the server to ask about a code it cannot find in the link). A first-time sign-in for an address CREATES the account, `getAdditionalUserInfo(cred).isNewUser` is `true`, and the account arrives `emailVerified: true` — redeeming a code mailed to that address is proof of control. The code is single-use.",
  status: "conforms",
  evidence: "ORACLE-BACKED on the client-side reject (`auth-signinwithemaillink-invalid-link`: `noOobCode: auth/argument-error`). The server arm for a code the project never issued answered `auth/invalid-action-code` in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on), and is replayed in `unit:oracle-conformance.test.ts`. Redeeming a real code needs a real inbox; that half is unit-backed end to end against the sandbox outbox (`unit:sandbox-email-link.test.ts` drives send -> read the outbox -> sign in).",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/argument-error`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-signinwithemaillink-invalid-link"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
