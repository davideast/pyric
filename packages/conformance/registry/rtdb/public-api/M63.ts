import { row } from './section.ts';

export default row({
  order: 720,
  featureKeys: ["orderByChild"],
  behavior: "`orderByChild('p')` on children missing the field treats their value as `null` (sorts FIRST per RTDB's type ordering)",
  status: "conforms",
  evidence: "`unit:modular/queries.test.ts` (\"orderByChild on a missing child path treats those children as null\"); matches oracle `rtdb-modular-startat-key-tiebreaker-and-missing-child.json` (local + SharedWorker + Node host replay)",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-startat-key-tiebreaker-and-missing-child"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 63,
});
