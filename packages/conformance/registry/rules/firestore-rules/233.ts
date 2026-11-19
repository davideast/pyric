import { row } from './section.ts';

export default row({
  order: 550,
  featureKeys: ["bind", "path"],
  behavior: "`Path.bind(map)` on `path()` strings substitutes `{x}` placeholders with string, int, and float values, and raises a runtime error (`Variable(s) x do not exist in the path template.`) when a map key has no matching `{x}` placeholder (such as `path('/a/$(x)').bind({'x': '1'})`)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-path-bind-forms` (4 cases) records production ALLOWING `path('/a/{x}').bind({'x': '1'}) == path('/a/1')`, `path('/a/{x}').bind({'x': 1.5}) == path('/a/1.5')`, and `path('/a/{x}').bind({'x': 1}) == path('/a/1')`, and DENYING `path('/a/$(x)').bind({'x': '1'}) == path('/a/1')` with `Variable(s) x do not exist in the path template.`. `bindPathSegments` in `packages/rules/src/simulator/wrappers/path.ts` enforces `{x}`-only placeholder matching, formats string/int/float values, and raises production's missing-template-variable error so negated or `!=` comparisons fail closed while `|| true` absorbs it; `unit:rules/oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts` replay all cases.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["ignoring unmatched Path.bind() keys allowed negated or inequality comparisons that production denies"],
  oracleObservations: ["rules-firestore-path-bind-forms"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
  ],
  constructs: ["firestore.function.cast.path", "firestore.method.path.bind"],
});
