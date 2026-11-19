import { row } from './section.ts';

export default row({
  order: 590,
  featureKeys: ["orderByKey","startAt","endAt"],
  behavior: "`orderByKey()` orders children by RTDB `nameCompare` — integer-looking keys sort numerically FIRST (so `['1','2','10']`, not the lexicographic `['1','10','2']`), then non-integer keys lexicographically; `startAt`/`endAt` cursors + the optional `key` tie-breaker use the same order (DB-B4)",
  status: "conforms",
  evidence: "`unit:upstream-rtdb-probes.test.ts` (INT32 overflow/underflow cursors) + `unit:modular/queries.test.ts` + `unit:modular/name-compare.test.ts`; matches oracle `rtdb-modular-orderbykey-namecompare.json` (replayed across local + SharedWorker + Node host) + `rtdb-modular-orderbykey-window.json` and upstream `core/util/util.ts:253-276`",
  risk: ["cursor-inclusivity"],
  riskScore: 2,
  riskReasons: ["asserts cursor/boundary semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-orderbykey-namecompare"],
  conformanceTests: ["packages/pyric/test/database/upstream-rtdb-probes.test.ts","packages/pyric/test/database/modular/name-compare.test.ts","packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 50,
});
