import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["verifyBeforeUpdateEmail"],
  api: "verifyBeforeUpdateEmail(user, newEmail)",
  behavior: "Mails a code to the NEW address and returns. The account's email does NOT change until that code is redeemed. A malformed new address is refused with `auth/invalid-new-email`. On redemption the account moves and the new address arrives `emailVerified: true`. `checkActionCode` on the code reports `data.email` = the new address and `data.previousEmail` = the old one. A session older than five minutes is refused with `auth/requires-recent-login` (oracle capture `auth-requires-recent-login`).",
  status: "diverged-documented",
  evidence: "Oracle `auth-verifybeforeupdateemail-shape`: the email stays unchanged until redeemed. Redemption needs a real inbox and is unit-backed. Divergence (#1693): a malformed new address gives `auth/invalid-new-email`, the sandbox `auth/invalid-email`. The replay pins both.",
  automation: "oracle-backed",
  oracleObservations: ["auth-verifybeforeupdateemail-shape"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-link.test.ts","packages/pyric/test/auth/oracle-conformance.test.ts"],
});
