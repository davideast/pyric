import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['Query.get', 'Query.once', 'Query.on', 'Query.off', 'Query.orderByChild'],
  api: 'Query ordering/bounds/limits (orderByChild, orderByKey, orderByValue, orderByPriority, startAt, startAfter, endAt, endBefore, equalTo, limitToFirst, limitToLast) and get / once / on / off',
  behavior:
  'Executes ordered, bounded, and limited reads (`orderByChild`, `orderByKey`, `orderByValue`, `orderByPriority`, `startAt`, `startAfter`, `endAt`, `endBefore`, `equalTo`, `limitToFirst`, `limitToLast`), binds 3-arg and 4-arg `this` context on `once` and `on`, scopes `off()` by query view, event type, callback, and context, and delivers `value` and two-phase windowed `child_*` events across local and remote arms. Under loaded rules, `Query#get()` rejects with `Index not defined` when `.indexOn` is absent for `orderByChild` or `orderByValue` while `once("value")` resolves (`orderByKey` and `orderByPriority` need no index); with no rules loaded, the zero-config sandbox requires no index.',
  status: 'conforms',
  automation: 'oracle-backed',
  oracleObservations: [
    'rtdb-modular-admin-query-index',
    'rtdb-modular-admin-query-bounds-listeners-and-context',
  ],
  conformanceTests: [
    'packages/pyric-admin/test/database/queries-parity.test.ts',
    'packages/pyric-admin/test/database/value-listeners-parity.test.ts',
    'packages/pyric-admin/test/database/child-listeners-parity.test.ts',
    'packages/pyric-admin/test/database/once-lifecycle-parity.test.ts',
    'packages/pyric-admin/test/database/remote-on-off-context.test.ts',
    'packages/pyric-admin/test/database/capture-admin-query-bounds-listeners-and-context.test.ts',
    'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-query-bounds-listeners-and-context.test.ts',
  ],
  evidence:
  'Production captures `rtdb-modular-admin-query-index` and `rtdb-modular-admin-query-bounds-listeners-and-context` record `.indexOn` enforcement on `Query#get()`, all four orderings with cursor bounds and limits, 3-arg/4-arg `this`-context binding, context-scoped `off()`, and two-phase limited-window `child_*` eviction events; replayed verbatim across in-process, remote, SharedWorker, and Node host arms.',
  risk: ['listener', 'specific-value'],
  riskScore: 3,
  riskReasons: ['asserts query windowing, child event sequencing, and admin .indexOn enforcement'],
});
