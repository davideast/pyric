import { row } from './section.ts';

export default row({
  order: 650,
  featureKeys: ["limitToFirst"],
  behavior: "`limitToFirst(N)` larger than the result returns the full window (no padding, no throw)",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"limitToFirst(N) larger than the result returns the full window\"); matches oracle `rtdb-modular-query-empty-and-oversized-window.json` (local + SharedWorker + Node host replay)",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-empty-and-oversized-window"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 56,
});
