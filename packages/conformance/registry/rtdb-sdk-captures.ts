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
      behavior: "Production: on a fresh client the transaction is sent against null, the set overtakes it, and runTransaction rejects with Error('set'); the update function was called with null and the final value is the set's. A client that holds a listener commits the transaction and then the set, as pyric does. The in-page sandbox commits on a cold client too. RT-15.",
      evidence: "`oracle:rtdb-modular-transaction-then-set` keys `cold` and `warm` (both clients were cold) and `oracle:rtdb-modular-transaction-then-set-warm`; CDD assertion `rtdb-modular#transaction-then-set-cold` pins both sides.",
      risk: ['atomicity', 'error-code'],
      riskScore: 3,
      riskReasons: ['asserts transaction/batch atomicity', "asserts the Error('set') rejection"],
      oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
      conformanceTests: [`${CDD}/capture-transaction-then-set.test.ts`],
    }),
    captureRow({
      rowRef: 'served-transaction-then-set',
      featureKeys: ['runTransaction', 'set'],
      api: 'runTransaction then set on the served planes',
      behavior: "Production: a warm client commits the transaction once and the set lands on top (final 100); a cold one fails the transaction. On the SharedWorker and Node host planes the transaction reruns on the set's value and commits on top (final 101), on cold and warm clients alike. RP-4.",
      evidence: '`oracle:rtdb-modular-transaction-then-set` and `oracle:rtdb-modular-transaction-then-set-warm`; pinned on the served worker client by `unit:cli/serve/worker/oracle-captures/rtdb-transaction-then-set.test.ts`. CDD assertion `rtdb-modular#served-transaction-then-set` pins the sandbox side, which matches the warm capture.',
      risk: ['atomicity'],
      riskScore: 3,
      riskReasons: ['asserts transaction/batch atomicity'],
      oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
      conformanceTests: [`${SERVED}/rtdb-transaction-then-set.test.ts`, `${CDD}/capture-transaction-then-set.test.ts`],
    }),
    captureRow({
      rowRef: 'remote-update-event-order',
      featureKeys: ['onValue', 'onChildAdded', 'onChildChanged', 'onChildRemoved', 'onChildMoved'],
      api: 'Event order for one remote multi-path update',
      behavior: 'Production delivers deeper paths first, and at each location child events before value, in the order removed, added, moved, changed: `A changed x`, `A value`, `R removed c`, `R added d`, `R changed a`, `R changed b`, `R value`, then the query\'s moved and changed events. The in-page sandbox fires value events first, parents before children, and child events in listener registration order. RT-2, RT-3.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order` key `log`; CDD assertion `rtdb-modular#remote-update-event-order` pins both sides.',
      risk: ['listener', 'timing'],
      riskScore: 3,
      riskReasons: ['asserts listener semantics', 'asserts event ordering'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest],
    }),
    captureRow({
      rowRef: 'priority-change-child-changed',
      featureKeys: ['setPriority', 'onChildChanged'],
      api: 'setPriority(ref) and child_changed',
      behavior: "Production fires child_changed on the parent's listeners for a priority-only change. Pyric fires none, on every plane. RT-4.",
      evidence: '`oracle:rtdb-modular-remote-update-event-order` (`R changed a` and `Q changed a` after setPriority); CDD assertion `rtdb-modular#priority-change-child-changed`, and the served pin in `unit:cli/serve/worker/oracle-captures/rtdb-remote-update-event-order.test.ts`.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
    }),
    captureRow({
      rowRef: 'priority-change-child-moved',
      featureKeys: ['setPriority', 'onChildMoved'],
      api: 'child_moved on a query with no orderBy',
      behavior: 'Production fires child_moved for a priority change on a query with no orderBy (`L moved a`). The in-page sandbox fires none; the served planes match production. RT-5, part of #138.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order`; CDD assertion `rtdb-modular#priority-change-child-moved`.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest],
    }),
    captureRow({
      rowRef: 'val-key-order',
      featureKeys: ['DataSnapshot'],
      api: 'Object.keys(snapshot.val())',
      behavior: 'Production returns `val()` keys in priority, then key order (`a,b,c`) for a ref and for an orderByValue query. Pyric returns insertion order for the ref (`b,a,c`) and query order for the query (`b,c,a`), on every plane. RT-7; the ref half is in #138.',
      evidence: '`oracle:rtdb-modular-remote-update-event-order` key `valKeys`; CDD assertion `rtdb-modular#val-key-order`.',
      risk: ['specific-value'],
      riskScore: 2,
      riskReasons: ['asserts key order'],
      oracleObservations: [EVENT_ORDER],
      conformanceTests: [eventOrderTest, `${SERVED}/rtdb-remote-update-event-order.test.ts`],
    }),
    captureRow({
      rowRef: 'served-event-order',
      featureKeys: ['onValue', 'onChildChanged'],
      api: 'Event order for one remote update on the served planes',
      behavior: "Production delivers one write's events deepest path first, child events before value. On the SharedWorker and Node host planes they arrive listener by listener in registration order. RP-5.",
      evidence: '`oracle:rtdb-modular-remote-update-event-order`; pinned on the served worker client by `unit:cli/serve/worker/oracle-captures/rtdb-remote-update-event-order.test.ts`. CDD assertion `rtdb-modular#served-event-order` pins the sandbox side (RT-2).',
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
      evidence: '`oracle:rtdb-modular-priority-window-limit-to-last`; CDD assertion `rtdb-modular#priority-window-limit-to-last` replays it with no pin.',
      risk: ['specific-value'],
      riskScore: 2,
      riskReasons: ['asserts query membership'],
      oracleObservations: ['rtdb-modular-priority-window-limit-to-last'],
      conformanceTests: [`${CDD}/capture-priority-window-limit-to-last.test.ts`],
    }),
    captureRow({
      rowRef: 'grandchild-priority-query-value',
      featureKeys: ['onValue', 'setPriority'],
      api: "onValue(query) and a grandchild's priority change",
      behavior: "Production fires a value event on every listener above a grandchild whose priority changes, orderByKey queries included. Pyric's query listeners miss it on every plane, though plain ref listeners get it. RP-8 (differential seed 7395).",
      evidence: '`oracle:rtdb-modular-grandchild-priority-query-value`; CDD assertion `rtdb-modular#grandchild-priority-query-value` pins both sides.',
      risk: ['listener'],
      riskScore: 2,
      riskReasons: ['asserts listener semantics'],
      oracleObservations: ['rtdb-modular-grandchild-priority-query-value'],
      conformanceTests: [`${CDD}/capture-grandchild-priority-query-value.test.ts`],
    }),
  ],
};
