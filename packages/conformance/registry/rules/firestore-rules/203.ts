import { row } from './section.ts';

export default row({
  order: 410,
  featureKeys: ["debug", "Map.hasAny", "Map.hasOnly"],
  behavior: "`debug()`, `map.hasAny()`, `map.hasOnly()`, an unknown method and an unknown global compile, and calling one is a \"Function not found\" runtime error that `|| true` absorbs",
  status: "conforms",
  evidence: "`oracle:rules-firestore-unknown-function-names-runtime-error` (captured 2026-10-27, 9 cases) records production compiling each name, DENYING the bare `debug()`, `map.hasAny` and `map.hasOnly` calls, and ALLOWING each under `|| true` and `!(map.hasOnly && false)`, so production does not reject them at compile. `unit:rules/oracle-conformance.test.ts` replays all 9 verdicts with no pin.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts that an unknown name is an absorbable runtime error, not a compile rejection"],
  oracleObservations: ["rules-firestore-unknown-function-names-runtime-error"],
  constructs: ["firestore.function.debug", "firestore.method.map.hasAny", "firestore.method.map.hasOnly"],
});
