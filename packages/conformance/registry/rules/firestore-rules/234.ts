import { row } from './section.ts';

export default row({
  order: 560,
  featureKeys: ["bind"],
  behavior: "An expression path literal with a `{x}` placeholder compiles and substitutes via `.bind(map)` (`(/a/{x}).bind({'x': '1'}) == path('/a/1')`)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-path-literal-brace-bind` (1 case) records production compiling `(/a/{x}).bind({'x': '1'}) == path('/a/1')` with zero compile issues and ALLOWING the request. Both the simulator and `lint()` accept `{x}` inside a `.bind(...)` path literal receiver; replayed by `unit:rules/oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["rejecting {x} inside (/a/{x}).bind(...) refuses rulesets production compiles and allows"],
  oracleObservations: ["rules-firestore-path-literal-brace-bind"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
    "packages/rules/test/linter/path-interpolation.test.ts",
  ],
  constructs: ["firestore.method.path.bind"],
});
