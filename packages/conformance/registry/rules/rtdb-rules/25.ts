import { row } from './section.ts';

export default row({
  order: 260,
  featureKeys: [],
  behavior: "Custom claims on the ID token read through `auth.token`: boolean, string, number and nested object claims, a claim the token does not carry, and `custom` as the sign-in provider of a custom-token sign-in",
  evidence: "`oracle:rules-rtdb-r31-token-claims` signs in with a custom token minted by the service account for each case's claims, the token production issues for those claims. Production allows `auth.token.admin == true`, `auth.token.role == 'editor'`, `auth.token.level >= 3` and `auth.token.org.tier == 'gold'` when the token carries that value and denies other values; reads a claim the token does not carry as null; reads `auth.token.firebase.sign_in_provider` and `auth.provider` as `custom`; and denies the admin gate for an anonymous user and a signed-out request. The simulator matches all 12 cases. The capture deletes every Auth user it signs in as and proves each deletion with a lookup.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts claim-gated rules allow/deny behavior"],
  oracleObservations: ["rules-rtdb-r31-token-claims"],
  constructs: ["rtdb.binding.auth.token", "rtdb.binding.auth.token.custom-claim"],
});
