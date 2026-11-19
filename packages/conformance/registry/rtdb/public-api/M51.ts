import { row } from './section.ts';

export default row({
  order: 600,
  featureKeys: ["orderByValue","limitToFirst"],
  behavior: "Under rules without `.indexOn: '.value'`, `get()` of `orderByValue() + limitToFirst(N)` rejects with a plain `Error` (no `code`) reading `Index not defined, add \".indexOn\": \".value\", for path \"<path>\", to the rules`; an `onValue` listener on the same query delivers the N smallest primitive values and logs the `@firebase/database` warning `Using an unspecified index. Your data will be downloaded and filtered on the client.` With the index declared, both return the window and nothing is logged",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-query-index-enforcement` deploys indexed and unindexed locations and records `get()`, `onValue()` and REST outcomes plus client log lines for each query shape; `unit:cdd/query-index-contracts.ts` replays every SDK case against the sandbox under the same rules and matches the observation exactly. Oracle `rtdb-modular-orderbyvalue-numeric` records the same rejection message, replayed in `unit:modular/oracle-conformance-queries.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-orderbyvalue-numeric","rtdb-modular-query-index-enforcement"],
  conformanceTests: ["packages/pyric/test/database/cdd/queries-and-listeners.test.ts","packages/pyric/test/database/modular/oracle-conformance-queries.test.ts","packages/pyric/test/rules/rtdb/query-and-indexon-soundness.test.ts","packages/cli/test/serve/worker/client/rtdb-listeners.test.ts"],
  rowNumber: 51,
});
