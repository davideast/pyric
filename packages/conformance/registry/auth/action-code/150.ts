import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["parseLink","parseActionCodeURL","ActionCodeURL"],
  api: "ActionCodeURL.parseLink(link) / parseActionCodeURL(link)",
  behavior: "Parses an out-of-band action link. The `mode` query param maps to a NORMALIZED operation (`mode=resetPassword` -> `PASSWORD_RESET`, `mode=signIn` -> `EMAIL_SIGNIN`), `oobCode` surfaces as `code`, `lang` as `languageCode`, and `continueUrl` comes out URL-DECODED. A link missing `mode`, missing `oobCode`, carrying an unknown mode, or that is not a URL at all parses to `null` — the parse NEVER throws. `parseActionCodeURL` and `ActionCodeURL.parseLink` agree.",
  status: "conforms",
  evidence: "ORACLE-BACKED and project-independent: this is a PURE client-side parse (no network, no project, no mailbox), so the sandbox owes prod an exact match and there is no room for a divergence. Oracle: `auth-actioncodeurl-parse` against firebase-js-sdk 12.19.0. Replayed in `unit:oracle-conformance.test.ts`.",
  risk: ["specific-value","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 6 specific parsed field values","asserts the mode->operation normalization"],
  automation: "oracle-backed",
  oracleObservations: ["auth-actioncodeurl-parse"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
