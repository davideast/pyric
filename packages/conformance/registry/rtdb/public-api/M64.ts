import { row } from './section.ts';

export default row({
  order: 730,
  featureKeys: ["query"],
  behavior: "`query` on a path holding a primitive has no child rows (`size === 0`, `forEach` empty): an unfiltered `orderBy*` query preserves the primitive leaf snapshot (`exists() === true`, `val()` returns the primitive), whereas a bounded or limited query (or any query on an absent path) returns an empty snapshot (`exists() === false`, `val() === null`)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/queries.test.ts` (\"query on a path with primitive value returns no rows\") + `unit:query-root-priority-listener.test.ts` + `packages/pyric-admin/test/database/firebase-admin-differential.test.ts`; matches oracle `rtdb-modular-query-primitive-leaf-and-object-ties.json` (local + SharedWorker + Node host replay); upstream `core/view/filter/IndexedFilter.ts` vs `RangedFilter.ts` / `LimitedFilter.ts`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-primitive-leaf-and-object-ties"],
  conformanceTests: ["packages/pyric/test/database/modular/queries.test.ts", "packages/pyric/test/database/query-root-priority-listener.test.ts", "packages/pyric/test/database/cdd/capture-query-semantics.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 64,
});
