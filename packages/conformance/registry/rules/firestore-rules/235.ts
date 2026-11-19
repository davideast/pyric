import { row } from './section.ts';

export default row({
  order: 570,
  featureKeys: ["bind"],
  behavior: "In `(/a/$(x)).bind({'x': '1'})` with wildcard `x` bound in the enclosing `match`, `$(x)` interpolates at literal evaluation and `.bind({'x': '1'})` raises `Variable(s) x do not exist in the path template.`",
  status: "conforms",
  evidence: "`oracle:rules-firestore-path-literal-dollar-bound-bind` (1 case) records production compiling `(/a/$(x)).bind({'x': '1'}) == path('/a/1')` under `match /items/{x}` (`x = 'orig'`) and DENYING at runtime with `Variable(s) x do not exist in the path template.`. `pathLiteral` evaluates `$(x)` to `'orig'` before `bindPathSegments` checks template placeholders, raising the absorbable evaluation error; replayed by `unit:rules/oracle-conformance.test.ts` and `unit:rules/simulator/path-bind-parity.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["silently returning Path('/a/orig') from (/a/$(x)).bind({'x': '1'}) fails open when compared against path('/a/orig') or !="],
  oracleObservations: ["rules-firestore-path-literal-dollar-bound-bind"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/path-bind-parity.test.ts",
  ],
  constructs: ["firestore.method.path.bind"],
});
