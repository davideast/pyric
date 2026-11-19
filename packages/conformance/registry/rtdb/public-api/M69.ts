import { row } from './section.ts';

export default row({
  order: 780,
  featureKeys: ["query","startAt","startAfter","endAt","endBefore","equalTo","limitToFirst","limitToLast"],
  behavior: "Conflicting query constraints throw synchronously at `query(...)` construction (NOT silent last-win): multiple `orderBy*`, a second `limitToFirst`/`limitToLast`, a second start (`startAt`/`startAfter`/`equalTo`) or end (`endAt`/`endBefore`/`equalTo`) (DB-B5)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/constraint-conflicts.test.ts` (5 cases); matches oracle `rtdb-modular-query-constraint-conflicts.json` (local + SharedWorker + Node host replay); upstream `api/Reference_impl.ts:160-165,1824-1841,1888-1905,1945-1951,2193-2206`",
  risk: ["timing"],
  riskScore: 2,
  riskReasons: ["asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-constraint-conflicts"],
  conformanceTests: ["packages/pyric/test/database/modular/constraint-conflicts.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 69,
});
