import { defineRows } from './define-rows.ts';
import type { CompatibilityTableBlock } from './types.ts';

/**
 * Rows backed by the 2026-10-27 SDK behavior hunt's production captures on
 * the dedicated RTDB oracle instance. Each observation comes from a scenario
 * in `src/capture/sdk-scenarios/rtdb/`, and the CDD files
 * `packages/pyric/test/database/cdd/capture-*.test.ts` replay the same
 * scenario, one `row()` per row. A `bug` row's test pins both answers under
 * the hunt's finding ID until its fix stream removes the pin.
 */
const CDD = 'packages/pyric/test/database/cdd';
const SERVED = 'packages/cli/test/serve/worker/oracle-captures';
const SECTION = 'Behavior checked against production captures';

const captureRow = defineRows({
  surface: 'rtdb-modular',
  defaults: { section: SECTION, status: 'bug', automation: 'oracle-backed', conformanceDisposition: 'pending-fix' },
});

const matchingRow = defineRows({
  surface: 'rtdb-modular',
  defaults: { section: SECTION, status: 'conforms', automation: 'oracle-backed' },
});

const EVENT_ORDER = 'rtdb-modular-remote-update-event-order';
const eventOrderTest = `${CDD}/capture-remote-update-event-order.test.ts`;

export const rtdbSdkCaptureBlock: CompatibilityTableBlock = {
  kind: 'table',
  prefix: '## Behavior checked against production captures\n\nEach row cites a production capture from the SDK behavior hunt. A `bug` row states production\'s behavior and pyric\'s; its test holds both answers until the fix lands.\n',
  rows: [
    captureRow({
      rowRef: 'transaction-then-set-cold',
      featureKeys: ['runTransaction', 'set'],
      api: 'runTransaction(ref, fn) followed at once by set(ref, value)',
      behavior: "On a cold production client the set overtakes the transaction, which rejects with Error('set'); pyric commits it. A warm client commits in both. RT-15.",
      evidence: "`oracle:rtdb-modular-transaction-then-set` keys `cold` and `warm` (both clients were cold) and `oracle:rtdb-modular-transaction-then-set-warm`.",
      risk: ['atomicity', 'error-code'],
      riskScore: 3,
      riskReasons: ['asserts transaction/batch atomicity', "asserts the Error('set') rejection"],
      oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
      conformanceTests: [`${CDD}/capture-transaction-then-set.test.ts`],
    }),
    matchingRow({
      rowRef: 'served-transaction-then-set',
      featureKeys: ['runTransaction', 'set'],
      api: 'runTransaction then set on the served planes',
      behavior: "On the served SharedWorker and Node host planes, a client write queued behind an in-flight transaction waits for the transaction to settle and commits on top (keeping the set's 100 rather than rerunning the transaction to 101). Cold-client Error('set') rejection remains tracked in transaction-then-set-cold. RP-4.",
      evidence: '`oracle:rtdb-modular-transaction-then-set` and `oracle:rtdb-modular-transaction-then-set-warm`, replayed on the served SharedWorker and Node host planes and in page.',
      risk: ['atomicity'],
      riskScore: 3,
      riskReasons: ['asserts transaction/batch atomicity'],
      oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
      conformanceTests: [`${SERVED}/rtdb-transaction-then-set.test.ts`, `${CDD}/capture-transaction-then-set.test.ts`],
    }),
    matchingRow({
      rowRef: 'remote-update-event-order',
      featureKeys: ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'],
      api: 'Event order for one remote multi-path update',
      behavior: 'Production and pyric fire deeper paths first and child events (`child_removed`, `child_added`, `child_moved`, `child_changed`) before `value` for one remote multi-path update across in-page and served planes. RT-2, RT-3.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order` key `log`, replayed in page and on the served SharedWorker and Node host planes.',
      risk: ['listener', 'timing'],
      riskScore: 3,
      riskReasons: ['asserts listener semantics', 'asserts event ordering'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
    }),
    matchingRow({
      rowRef: 'priority-change-child-changed',
      featureKeys: ['setPriority', 'onChildChanged'],
      api: 'setPriority(ref) and child_changed',
      behavior: "Production and pyric fire `child_changed` on the parent's reference and query listeners for a priority-only change (`setPriority`) across in-page and served planes. RT-4.",
      evidence: '`oracle:rtdb-modular-remote-update-event-order` (`R changed a` and `Q changed a` after `setPriority`), replayed in page and on the served SharedWorker and Node host planes.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
    }),
    matchingRow({
      rowRef: 'priority-change-child-moved',
      featureKeys: ['setPriority', 'onChildMoved'],
      api: 'child_moved on a query with no orderBy',
      behavior: 'Production and pyric fire `child_moved` for a priority change on a query with no `orderBy` (`L moved a`) across in-page and served planes. RT-5, part of #138.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order`, replayed in page and on the served SharedWorker and Node host planes.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
    }),
    matchingRow({
      rowRef: 'val-key-order',
      featureKeys: ['DataSnapshot'],
      api: 'Object.keys(snapshot.val())',
      behavior: 'Production and pyric order `val()` keys by priority, then key, on a ref and a query snapshot. RT-7, fixed in #1371.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order` key `valKeys`, replayed in page and on the served planes; `packages/pyric/test/database/modular/snapshot-serialization.test.ts` adds priorities and nested values.',
      risk: ['specific-value'],
      riskScore: 2,
      riskReasons: ['asserts key order'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [
        eventOrderTest,
        `${SERVED}/rtdb-remote-update-event-order.test.ts`,
        'packages/pyric/test/database/modular/snapshot-serialization.test.ts',
      ],
    }),
    matchingRow({
      rowRef: 'served-event-order',
      featureKeys: ['onValue', 'onChildChanged'],
      api: 'Event order for one remote update on the served planes',
      behavior: "Production and the served SharedWorker and Node host planes deliver one write's events deepest path first, child events before value. RP-5.",
      evidence: '`oracle:rtdb-modular-remote-update-event-order`, replayed on the served SharedWorker and Node host planes and in page.',
      risk: ['listener', 'timing'],
      riskScore: 3,
      riskReasons: ['asserts listener semantics', 'asserts event ordering'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [`${SERVED}/rtdb-remote-update-event-order.test.ts`, eventOrderTest],
    }),
    matchingRow({
      rowRef: 'priority-window-limit-to-last',
      featureKeys: ['orderByPriority', 'limitToLast'],
      api: 'orderByPriority with endAt or endBefore and limitToLast over children with no priority',
      behavior: 'Production and pyric give the same keys: `z` for endAt("1","A") with limitToLast(1), `b,z` for endBefore("1") with limitToLast(2), `1,10,A,a,b,z` with no limit, and `a,b,z` for the endAt(2) limitToLast(3) control. The capture refuted hunt finding RT-17.',
      evidence: '`oracle:rtdb-modular-priority-window-limit-to-last`.',
      risk: ['specific-value'],
      riskScore: 2,
      riskReasons: ['asserts query membership'],
      oracleObservations: ['rtdb-modular-priority-window-limit-to-last'],
      conformanceTests: [`${CDD}/capture-priority-window-limit-to-last.test.ts`],
    }),
    matchingRow({
      rowRef: 'grandchild-priority-query-value',
      featureKeys: ['onValue', 'setPriority'],
      api: "onValue(query) and a grandchild's priority change",
      behavior: "Production and pyric fire a value event on every reference and query listener above a grandchild whose priority changes, orderByKey queries included, across in-page and served planes. RP-8 (differential seed 7395).",
      evidence: '`oracle:rtdb-modular-grandchild-priority-query-value`, replayed in page and on the served SharedWorker and Node host planes.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: ['rtdb-modular-grandchild-priority-query-value'],
      conformanceTests: [
        `${CDD}/capture-grandchild-priority-query-value.test.ts`,
        `${SERVED}/rtdb-grandchild-priority-query-value.test.ts`,
      ],
    }),
    matchingRow({
      rowRef: 'leaf-promotion-priority',
      featureKeys: ['set', 'update', 'setWithPriority', 'onDisconnect'],
      api: 'Leaf-to-parent promotion .priority retention across set, update, and onDisconnect',
      behavior: 'When a scalar leaf carrying a numeric or string `.priority` acquires a child via direct `set`/`update`, committed-leaf `onDisconnect` `set`/`update`, or same-session queued `onDisconnect` folding, production and pyric retain the promoted parent `.priority` across rules `newData.getPriority()`, client snapshots, and `exportVal()` on in-page and served planes.',
      evidence: '`oracle:rtdb-modular-leaf-promotion-priority`, replayed in page and on the served worker plane.',
      risk: ['specific-value', 'stateful'],
      riskScore: 2,
      riskReasons: ['asserts priority retention across leaf-to-parent promotion and onDisconnect folding'],
      oracleObservations: ['rtdb-modular-leaf-promotion-priority'],
      conformanceTests: [
        `${CDD}/capture-leaf-promotion-priority.test.ts`,
        `${SERVED}/rtdb-leaf-promotion-priority.test.ts`,
      ],
    }),
    matchingRow({
      rowRef: 'query-limit-infinity',
      featureKeys: ['query', 'limitToFirst', 'limitToLast', 'get', 'onValue'],
      api: 'limitToFirst(Infinity) and limitToLast(Infinity) client acceptance, unanswered reads, and rules query.* null mapping',
      behavior: 'Client `limitToFirst(Infinity)` and `limitToLast(Infinity)` construct a `Query` without throwing (while `-Infinity`, `NaN`, and `0` throw `"limitToFirst: First argument must be a positive integer."`), map non-finite limits to `null` in `query.limitToFirst` / `query.limitToLast` rules evaluation, and leave wire `get()` and `onValue()` / child listeners unanswered without stalling subsequent finite reads.',
      evidence: '`oracle:rtdb-modular-query-limit-infinity`, replayed in page and on the served worker plane.',
      risk: ['specific-value', 'listener'],
      riskScore: 2,
      riskReasons: ['asserts client limit validation, unanswered non-finite query behavior, and rules query.* null semantics'],
      oracleObservations: ['rtdb-modular-query-limit-infinity'],
      conformanceTests: [
        `${CDD}/capture-query-limit-infinity.test.ts`,
        `${SERVED}/rtdb-query-limit-infinity.test.ts`,
      ],
    }),
  ],
};
