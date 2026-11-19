import { row } from './section.ts';

export default row({
  order: 300,
  featureKeys: [],
  behavior: "The exact six shared `auth` and `membership` function bodies preserve signed-in, owner, custom-claim, explicit membership-map, and role semantics under Firestore Rules",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-21: one bounded, read-only Firestore Rules Test API request captured 12 verdicts for the exact bodies shipped from `auth` and `membership`; `oracle:rules-firestore-common-auth-membership-firestore` matches the local Firestore rules simulator verdict-for-verdict (6 ALLOW, 6 DENY). The cross-service source-lock test requires these six Firestore corpus bodies, the previously captured Storage corpus bodies, and the shipped modules to remain normalized-AST-identical.",
  oracleObservations: ["rules-firestore-common-auth-membership-firestore"],
  constructs: [
    "firestore.binding.request.auth",
    "firestore.binding.request.auth.uid",
    "firestore.binding.request.auth.token",
    "firestore.operator.in",
    "firestore.rule-kind.function",
  ],
});
