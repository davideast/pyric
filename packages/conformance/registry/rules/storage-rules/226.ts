import { row } from './section.ts';

export default row({
  order: 640,
  featureKeys: ["bind"],
  behavior: "`(/a/$(x)).bind({'x': '1'})` with unbound `x` compiles without a compile error (emitting a compile warning) and denies at runtime when evaluating `$(x)`",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-storage-path-literal-dollar-unbound-bind` (1 case) records production compiling `(/a/$(x)).bind({'x': '1'}) == path('/a/1')` when `x` is unbound (with `WARNING@5:27 Invalid variable name: x.`) and DENYING at runtime when evaluating `$(x)`. `parseStorageRules` compiles the ruleset and `evalExpr` returns an absorbable `RuleError` on unbound `x`; replayed by `unit:storage/rules-oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts compile-time acceptance vs runtime denial boundary"],
  oracleObservations: ["rules-storage-storage-path-literal-dollar-unbound-bind"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
  ],
  constructs: ["storage.method.path.bind"],
});
