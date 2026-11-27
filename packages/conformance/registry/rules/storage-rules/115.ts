import { row } from './section.ts';

export default row({
  order: 150,
  featureKeys: ["firestore.get","firestore.exists"],
  behavior: "Cross-service `firestore.get()` / `firestore.exists()` lookups from a Storage ruleset, with `$(expr)` path interpolation and qualified function-mock names",
  status: "conforms",
  evidence: "Production captures prove the evaluator resolves cross-service Firestore lookups from Storage rules, including interpolated document paths for strings, ints, and floats formatted via Java Double.toString (`formatRulesFloat`), and both the map-returning `get()` and bool-returning `exists()` forms. `oracle:rules-storage-firestore-lookup` (4 cases) and `oracle:rules-storage-h1-lookup-float-interpolation` (8 cases, #1815) match production verdict-for-verdict.",
  automation: "oracle-backed",
  oracleObservations: [
    "rules-storage-firestore-lookup",
    "rules-storage-h1-lookup-float-interpolation",
  ],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-firestore-lookup-paths.test.ts",
  ],
});
