import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: [],
  behavior: "`Path` wrapper, `path()` constructor, and `Path.bind()` (Item 5.4) in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-path-constructor-and-bind` — production Firestore Rules Test API verdicts for all nine corpus cases in \"path-constructor-and-bind\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`, including production's rejection of a Path argument to `path()`.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-path-constructor-and-bind"],
  constructs: ["firestore.function.cast.path","firestore.method.path.bind"],
});
