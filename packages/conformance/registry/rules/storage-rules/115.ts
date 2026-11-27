import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["firestore.get","firestore.exists"],
  behavior: "Cross-service `firestore.get()` / `firestore.exists()` lookups from a Storage ruleset, with `$(expr)` path interpolation and qualified function-mock names",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-10: production capture proves the evaluator resolves cross-service Firestore lookups from Storage rules, including interpolated document paths and both the map-returning `get()` and bool-returning `exists()` forms. `oracle:rules-storage-firestore-lookup` matches production verdict-for-verdict on all 4 cases.",
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-firestore-lookup"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
