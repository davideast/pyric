import { row } from './section.ts';

export default row({
  order: 590,
  featureKeys: ["service"],
  behavior: "A Firestore ruleset whose sole service block is `service firebase.storage` compiles without error and denies every Firestore request (#1434)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-service-name-storage-in-firestore` (1 case) records production compiling a sole `service firebase.storage` ruleset with zero compile issues and DENYING a Firestore `get` request. `checkRulesSource` accepts non-Firestore service blocks while `root-match.ts` and `static-query-proof-rules.ts` match only `service cloud.firestore`, so every load path compiles the ruleset and denies Firestore reads, queries, and writes; replayed by `unit:rules/oracle-conformance.test.ts`, `unit:rules/grammar/source-service-check.test.ts`, and `unit:rules/grammar/corpus.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["evaluating non-Firestore service blocks as Firestore rules fails open, while refusing them at compile time diverges from production"],
  oracleObservations: ["rules-firestore-service-name-storage-in-firestore"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/grammar/source-service-check.test.ts",
    "packages/rules/test/grammar/corpus.test.ts",
    "packages/rules/test/linter/service-declarations.test.ts",
  ],
});
