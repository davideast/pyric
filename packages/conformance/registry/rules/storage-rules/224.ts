import { row } from './section.ts';

export default row({
  order: 620,
  featureKeys: ["bind"],
  behavior: "An expression path literal with a `{x}` placeholder compiles and substitutes via `.bind(map)` (`(/a/{x}).bind({'x': '1'}) == path('/a/1')`)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-path-literal-brace-bind` (1 case) records production compiling `(/a/{x}).bind({'x': '1'}) == path('/a/1')` with zero compile issues and ALLOWING the request. `parseStorageRules` and `evaluateStorageRules` preserve `{x}` literal segments for `.bind()`; replayed by `unit:storage/rules-oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["rejecting {x} inside (/a/{x}).bind(...) refuses Storage rulesets production compiles and allows"],
  oracleObservations: ["rules-storage-storage-path-literal-brace-bind"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
  ],
  constructs: ["storage.method.path.bind"],
});
