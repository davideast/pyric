import { row } from './section.ts';

export default row({
  order: 290,
  featureKeys: ["firestore.get", "firestore.exists"],
  behavior: "Mocked Storage-to-Firestore lookup evaluation: get/exists return and missing-field errors, repeated and same-resolved-path calls, get+exists composition, and lazy `||`/`&&`/ternary branches with hosted function-call diagnostics",
  status: "diverged-documented",
  evidence: "DOCUMENTED MOCK-ORACLE DIVERGENCE, 2026-07-21: `oracle:rules-storage-firestore-lookup-budget` matches the local evaluator on 13 of 14 cases and hosted diagnostics prove lazy branches omit lookup calls. The one mismatch is intentional and pinned on both sides: the Rules Test API ALLOWs three distinct mocked exists calls, while the evaluator DENYs the third distinct path to match the separately captured real-resource production contract in row #131. This row remains diverged because its mocked observation is not verdict-identical; it supplies no budget credit.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["documents a hosted-mock versus real-resource rules-denial mismatch"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-firestore-lookup-budget"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.function.firestore.get", "storage.function.firestore.exists"],
});
