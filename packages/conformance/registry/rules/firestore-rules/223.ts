import { row } from './section.ts';

export default row({
  order: 450,
  featureKeys: ["match"],
  behavior: "The write rules written on a root `match /{path=**}` block apply: `allow write: if request.auth != null` on the root allows a signed-in create and denies a signed-out one (FS3-ROOT-1)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-root-recursive-own-allow-write` (captured 2026-11-04, 2 cases) records production ALLOWING a signed-in create of `c/1` and DENYING a signed-out one, whose diagnostic reads \"Property auth is undefined on object.\". The simulator evaluates the root's own rules (#1894), and `unit:rules/oracle-conformance.test.ts` replays both verdicts with no pin. `unit:rules/simulator/root-own-allow.test.ts` replays them through `simulate()` and the in-page sandbox.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["writes under a ruleset whose rules sit on a root recursive block are denied where production allows them"],
  oracleObservations: ["rules-firestore-root-recursive-own-allow-write"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/simulator/root-own-allow.test.ts",
  ],
  constructs: ["firestore.rule-kind.match"],
});
