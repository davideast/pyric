import { row } from './section.ts';

export default row({
  order: 320,
  featureKeys: ["bool", "math.isInfinite", "hasAll"],
  behavior: "Compile-time AST verification rejects non-conforming casts (bool()), unsupported helper methods (math.isInfinite()), and bare Map membership assertions (map.hasAll).",
  status: "conforms",
  evidence: "Captured production behavior via rules-firestore-ast-strictness-and-unsupported-casts proves compile-time AST verification and execution rejection of bool(), math.isInfinite(), and bare Map membership assertions (map.hasAll).",
  automation: "oracle-backed",
  oracleObservations: ["rules-firestore-ast-strictness-and-unsupported-casts"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/linter/hallucinations.test.ts",
  ],
  constructs: [
    "firestore.function.cast.bool",
    "firestore.function.math.isInfinite",
    "firestore.method.map.hasAll",
  ],
});
