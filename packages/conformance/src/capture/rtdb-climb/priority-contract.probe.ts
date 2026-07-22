import {
  child,
  equalTo,
  get,
  limitToFirst,
  off,
  onChildMoved,
  onValue,
  orderByPriority,
  query,
  ref,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  startAt,
  update,
} from 'firebase/database';
import {
  adminRead,
  adminRemove,
  captureInvocation,
  cleanup,
  createClient,
  repeatStable,
  scenarioPath,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-priority-contract',
      matrixRow: 'rtdb-modular#M46, rtdb-modular#M89, rtdb-modular#M90, rtdb-modular#M91',
      rowIds: ['rtdb-modular#M46', 'rtdb-modular#M89', 'rtdb-modular#M90', 'rtdb-modular#M91'],
      description:
        'Priority round trips, replacement/preservation/clearing, priority ordering with bounds and limits, movement, and transaction lifecycle.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'priority-contract', attempt);
        const client = await createClient(ctx, `priority-contract-${attempt}`);
        const target = ref(client.db, path);
        const moved: Array<[string | null, string | null]> = [];
        const plainMoved: Array<[string | null, string | null]> = [];
        let orderedValueDeliveries = 0;
        try {
          await setWithPriority(child(target, 'a'), { value: 1 }, 10);
          await setWithPriority(child(target, 'b'), { value: 2 }, 5);
          await setWithPriority(child(target, 'c'), { value: 3 }, 5);
          const before = await Promise.all(['a', 'b', 'c'].map(async (key) => {
            const snap = await get(child(target, key));
            return { key, priority: snap.priority, exportVal: snap.exportVal() };
          }));
          const orderedKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority()))).forEach((snap) => {
            orderedKeys.push(snap.key);
          });
          const boundedKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority(), startAt(5), limitToFirst(2)))).forEach((snap) => {
            boundedKeys.push(snap.key);
          });
          const equalKeys: Array<string | null> = [];
          (await get(query(target, orderByPriority(), equalTo(5)))).forEach((snap) => {
            equalKeys.push(snap.key);
          });
          const plainForEachKeys: Array<string | null> = [];
          const parentSnapshot = await get(target);
          parentSnapshot.forEach((snap) => { plainForEachKeys.push(snap.key); });
          const defaultLimitedKeys: Array<string | null> = [];
          (await get(query(target, limitToFirst(2)))).forEach((snap) => {
            defaultLimitedKeys.push(snap.key);
          });
          const parentExportVal = parentSnapshot.exportVal();
          const parentToJSON = parentSnapshot.toJSON();
          const invalidPriorityBounds = {
            boolean: await captureInvocation(() =>
              query(target, orderByPriority(), startAt(false))),
            object: await captureInvocation(() =>
              query(target, orderByPriority(), startAt({ invalid: true } as unknown as null))),
            defaultBoolean: await captureInvocation(() => query(target, startAt(false))),
            defaultObject: await captureInvocation(() =>
              query(target, startAt({ invalid: true } as unknown as null))),
          };
          onChildMoved(query(target, orderByPriority()), (snap, previous) => moved.push([snap.key, previous]));
          onChildMoved(target, (snap, previous) => plainMoved.push([snap.key, previous]));
          onValue(query(target, orderByPriority()), () => { orderedValueDeliveries += 1; });
          await waitFor('priority listener initial readiness', () => orderedValueDeliveries === 1);
          await setPriority(child(target, 'a'), 0);
          await waitFor('priority movement readiness', () =>
            moved.length === 1 && plainMoved.length === 1 && orderedValueDeliveries === 2);
          const movedAfterReorder = [...moved];
          const plainMovedAfterReorder = [...plainMoved];
          const orderedValueDeliveriesAfterMove = orderedValueDeliveries;
          await setPriority(child(target, 'c'), 6);
          await waitFor('same-position priority listener readiness', () =>
            moved.length === 2 && plainMoved.length === 2 && orderedValueDeliveries === 3);
          const samePositionMoved = moved.slice(movedAfterReorder.length);
          const samePositionPlainMoved = plainMoved.slice(plainMovedAfterReorder.length);
          const orderedValueDeliveriesAfterSamePositionChange = orderedValueDeliveries;
          const afterMove = await get(child(target, 'a'));
          await update(target, { 'a/value': 4 });
          const afterUpdate = (await get(child(target, 'a'))).priority;
          await runTransaction(child(target, 'a'), (current) => ({
            value: ((current as { value?: number } | null)?.value ?? 0) + 1,
          }));
          const afterTransaction = (await get(child(target, 'a'))).priority;
          await set(child(target, 'b'), { value: 20 });
          const afterSet = (await get(child(target, 'b'))).priority;
          await setPriority(child(target, 'c'), null);
          const afterClear = await get(child(target, 'c'));
          const listenerParent = ref(client.db, `${path}-descendant-listener`);
          const listenerChild = child(listenerParent, 'child');
          await setWithPriority(listenerChild, 1, 9);
          const descendantPriorityDeliveries: Array<{ value: unknown; priority: unknown }> = [];
          onValue(listenerChild, (snapshot) => {
            descendantPriorityDeliveries.push({
              value: snapshot.val(),
              priority: snapshot.priority,
            });
          });
          await waitFor('descendant priority listener initial readiness', () =>
            descendantPriorityDeliveries.length === 1);
          await set(listenerParent, { child: 1 });
          await waitFor('ancestor replacement priority listener readiness', () =>
            descendantPriorityDeliveries.length === 2);
          const afterAncestorReplacementCount = descendantPriorityDeliveries.length;
          await setPriority(listenerParent, 4);
          const afterAncestorPriorityOnlyCount = descendantPriorityDeliveries.length;
          await set(listenerChild, 2);
          await waitFor('descendant priority listener write control readiness', () =>
            descendantPriorityDeliveries.length > afterAncestorPriorityOnlyCount);
          return {
            before,
            orderedKeys,
            boundedKeys,
            equalKeys,
            plainForEachKeys,
            defaultLimitedKeys,
            parentExportVal,
            parentToJSON,
            invalidPriorityBounds,
            moved: movedAfterReorder,
            plainMoved: plainMovedAfterReorder,
            samePositionMoved,
            samePositionPlainMoved,
            allMoved: moved,
            allPlainMoved: plainMoved,
            orderedValueDeliveriesAfterMove,
            orderedValueDeliveriesAfterSamePositionChange,
            totalOrderedValueDeliveries: orderedValueDeliveries,
            afterMove: { priority: afterMove.priority, exportVal: afterMove.exportVal() },
            afterUpdate,
            afterTransaction,
            afterSet,
            afterClear: { priority: afterClear.priority, exportVal: afterClear.exportVal() },
            descendantPriorityDeliveries: [...descendantPriorityDeliveries],
            afterAncestorReplacementCount,
            afterAncestorPriorityOnlyCount,
            terminal: await adminRead(ctx, path),
          };
        } finally {
          off(target);
          await cleanup([
            () => client.close(),
            () => adminRemove(ctx, path),
            () => adminRemove(ctx, `${path}-descendant-listener`),
          ]);
        }
      }),
    };
}
