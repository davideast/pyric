import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["sendSignInLinkToEmail"],
  api: "sendSignInLinkToEmail — `auth/unauthorized-continue-uri` (domain allowlist)",
  behavior: "Prod rejects a continue URL whose domain is not on the project's authorized-domains list. The sandbox has NO domain allowlist and does not invent one: it accepts any parseable continue URL. A continue URL that would be rejected in production is accepted here.",
  status: "diverged-documented",
  evidence: "The sandbox has no project config to hold an authorized-domains list, so there is nothing to check against; inventing an allowlist would mean inventing a policy the user never set. The production side is ORACLE-BACKED: `auth-sendsigninlinktoemail-settings-validation`, in the #1676 re-capture (firebase 12.19.0, digame-mas, Email/Password and Email Enumeration Protection on), captured `unauthorizedDomain: auth/unauthorized-continue-uri` for a continue domain off the allowlist.",
  automation: "oracle-backed",
  oracleObservations: ["auth-sendsigninlinktoemail-settings-validation"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-link.test.ts"],
});
