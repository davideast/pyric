import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["orderByValue"],
  behavior: "Under loaded rules, `orderByValue()` and `orderByChild(path)` need `.indexOn: '.value'` or `.indexOn: '<path>'` at the queried location: `get()` rejects with `Index not defined`, limited or unlimited, and a listener downloads the location, filters it locally, and logs the unspecified-index warning only when the query has a limit or a range. `orderByKey()` needs no index. A rules-bypassing admin handle meets the same requirement: its `get()` rejects and its listener warns. With no rules loaded, the sandbox requires no index",
  evidence: "Oracle `rtdb-modular-query-index-enforcement` covers `orderByChild` and `orderByValue` with a limit, without a limit, and with `startAt`, plus `orderByKey` with a limit, each at an indexed and an unindexed location; `unit:cdd/query-index-contracts.ts` replays the `get()` and `onValue()` cases in the sandbox and matches outcomes and log lines. The served worker path delivers the same rejection and logs the warning in the page (`packages/cli/test/serve/worker/client/rtdb-listeners.test.ts`). Oracle `rtdb-modular-admin-query-index` (captured 2026-10-07) records the Admin SDK getting the same `Index not defined` rejection from `get()`, limited and unlimited, and a limited `once('value')` delivering the filtered window with the unspecified-index warning; `unit:modular/admin-query-index.test.ts` replays it on a `getAdminDatabase` handle.",
  oracleObservations: ["rtdb-modular-admin-query-index","rtdb-modular-orderbyvalue-numeric","rtdb-modular-query-index-enforcement"],
  conformanceTests: ["packages/pyric/test/database/cdd/public-operations.test.ts","packages/pyric/test/database/modular/admin-query-index.test.ts","packages/pyric/test/database/modular/oracle-conformance-queries.test.ts","packages/pyric/test/database/index-diagnostics.test.ts","packages/cli/test/serve/worker/client/rtdb-listeners.test.ts"],
  aliases: ["rtdb#144"],
});
