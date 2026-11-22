import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["verifyBeforeUpdateEmail"],
  api: "verifyBeforeUpdateEmail(user, newEmail)",
  behavior: "Mails a code to the NEW address and returns. The account's email does NOT change until that code is redeemed. A malformed new address is refused with `auth/invalid-new-email`. On redemption the account moves and the new address arrives `emailVerified: true`. `checkActionCode` on the code reports `data.email` = the new address and `data.previousEmail` = the old one. A session older than five minutes is refused with `auth/requires-recent-login` (oracle capture `auth-requires-recent-login`).",
  status: "conforms",
  evidence: "Oracle `auth-verifybeforeupdateemail-shape` (`emailUnchangedUntilLinkClicked: true`, `malformedTargetCode: 'auth/invalid-new-email'`), replayed in `unit:oracle-conformance.test.ts` and `packages/cli/test/serve/worker/auth-sdk-results-tokens-parity.test.ts`. Redemption needs a real inbox and is unit-backed in `unit:sandbox-email-link.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["auth-verifybeforeupdateemail-shape"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-link.test.ts","packages/pyric/test/auth/oracle-conformance.test.ts","packages/cli/test/serve/worker/auth-sdk-results-tokens-parity.test.ts"],
});
