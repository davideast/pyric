import { row } from './section.ts';

export default row({
  order: 610,
  featureKeys: ["bind", "path"],
  behavior: "`Path.bind(map)` on `path()` strings substitutes `{x}` placeholders with string, int, and float values, and raises `Variable(s) x do not exist in the path template.` on `path('/a/$(x)').bind({'x': '1'})`",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-path-bind-forms` (4 cases) records production ALLOWING `path('/a/{x}').bind({'x': '1'}) == path('/a/1')`, `path('/a/{x}').bind({'x': 1.5}) == path('/a/1.5')`, and `path('/a/{x}').bind({'x': 1}) == path('/a/1')`, and DENYING `path('/a/$(x)').bind({'x': '1'}) == path('/a/1')` with `Variable(s) x do not exist in the path template.`. `StoragePath.bind()` shares `bindPathSegments` with Firestore `Path.bind()`, fixing both the prior `$(x)` substitution allow-divergence and `RulesFloat` rejection; replayed by `unit:storage/rules-oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["StoragePath.bind() previously substituted $(x) placeholders that production denies and rejected float map values that production allows"],
  oracleObservations: ["rules-storage-storage-path-bind-forms"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
  ],
  constructs: ["storage.function.cast.path", "storage.method.path.bind"],
});
