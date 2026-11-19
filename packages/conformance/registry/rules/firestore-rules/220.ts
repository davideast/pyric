import { row } from './section.ts';

export default row({
  order: 420,
  featureKeys: ["match"],
  behavior: "The `allow` statements written on a root `match /{path=**}` block apply, as on any other block: the root matches every document's full resource name (FS3-ROOT-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-root-recursive-with-own-allow` (captured 2026-11-04, 2 cases) records production ALLOWING get `c/1` and list `c` under `match /{path=**} { allow read: if true; }`. `collectRootMatches` in `rules/simulator/root-match.ts` includes the root block when its path covers the request's full resource name (#1894), and `unit:rules/oracle-conformance.test.ts` replays both verdicts with no pin. `unit:rules/simulator/root-own-allow.test.ts` replays them through `simulate()` and the in-page sandbox.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["a ruleset whose rules sit on a root recursive block is denied requests production allows"],
  oracleObservations: ["rules-firestore-root-recursive-with-own-allow"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/simulator/root-own-allow.test.ts",
  ],
  constructs: ["firestore.rule-kind.match"],
});
