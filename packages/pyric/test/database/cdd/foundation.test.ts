import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  api,
  assertMultipath,
  assertNullRemoval,
  assertOverlappingUpdate,
  assertPush,
  assertReferenceShape,
  assertRoundTrip,
  assertSetReplacement,
  assertSnapshotShape,
  assertTimestamp,
  assertTransaction,
  assertUpdateMerge,
  assertValueListener,
  setup,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';
import {
  assertChangedChildContract,
  assertChangedChildExcludesAddsAndRemovals,
  assertInitialAddedChildrenContract,
  assertMovedChildContract,
  assertOffRemovesEveryListenerVariety,
  assertPostSubscribeAddedChildContract,
  assertRemovedChildContract,
  assertTargetedOffAndUnsubscribe,
} from './foundation-child-listener-contracts.js';
import {
  assertDeniedErrorEnvelope,
  assertMissingValueListener,
  assertSetDataBypassesRules,
} from './foundation-control-contracts.js';
import {
  assertDatabaseBackendIdentity,
  assertFrozenIdentityRouting,
  assertLiveIdentityRouting,
} from './foundation-identity-contracts.js';
import {
  assertApplyLocallyContract,
  assertDeniedTransactionEnvelope,
  assertTransactionAbortContract,
  assertTransactionContentionBoundary,
} from './foundation-transaction-contracts.js';

const currentValueObservation = loadObservation('rtdb-modular-runtransaction-current-value-arg');

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: foundation rows', () => {
  row('M1', assertFrozenIdentityRouting);
  row('M2', assertLiveIdentityRouting);
  row('M3', () => expect(() => api.getDatabase({} as never)).toThrow(/package resolution/i));
  row('M4', () => {
    const { db } = setup();
    expect([api.ref(db).key, api.ref(db, 'a').key]).toEqual([null, 'a']);
  });
  row('M5', () => assertReferenceShape());
  row('M6', () => {
    const { db } = setup();
    expect([api.ref(db).parent, api.ref(db, 'a/b').parent?.key]).toEqual([null, 'a']);
  });
  row('M7', () => {
    const { db } = setup();
    expect(api.ref(db, 'a/b').root.isEqual(api.ref(db))).toBe(true);
  });
  row('M8', () => assertSnapshotShape());
  row('M9', async () => {
    const { db } = setup(); const snap = await api.get(api.ref(db, 'missing'));
    expect([snap.val(), snap.exists()]).toEqual([null, false]);
  });
  row('M10', assertSetReplacement);
  row('M11', () => assertNullRemoval(false));
  row('M12', () => assertNullRemoval(true));
  row('M13', assertUpdateMerge);
  row('M14', async () => {
    const { db } = setup(); const target = api.ref(db, 'x');
    await api.set(target, { a: 1, b: 2 }); await api.update(target, { a: null });
    expect((await api.get(target)).val()).toEqual({ b: 2 });
  });
  row('M15', assertMultipath);
  row('M16', assertOverlappingUpdate);
  row('M17', () => assertPush(false));
  row('M18', () => assertPush(true));
  row('M19', () => {
    const first = api.pushKey(); const second = api.pushKey();
    expect(first).toMatch(/^-.{19}$/); expect(second).not.toBe(first);
  });
  row('M20', () => expect(api.serverTimestamp()).toEqual({ '.sv': 'timestamp' }));
  row('M21', () => assertTimestamp(false));
  row('M22', () => assertTimestamp(true));
  row('M23', () => assertDeniedErrorEnvelope('write'));
  row('M24', () => assertDeniedErrorEnvelope('read'));
  row('M25', () => assertDeniedErrorEnvelope('remove'));
  row('M26', () => assertValueListener('initial'));
  row('M27', async () => {
    const { db } = setup(); const target = api.ref(db, 'watch'); const seen: unknown[] = [];
    const unsub = api.onValue(target, snap => seen.push(snap.val()));
    await api.set(target, 1); await api.set(target, 1); expect(seen).toEqual([null, 1]); unsub();
  });
  row('M28', () => assertValueListener('descendant'));
  row('M29', assertMissingValueListener);
  row('M30', () => assertValueListener('unsubscribe'));
  row('M31', () => {
    expect([api.onChildAdded, api.onChildChanged, api.onChildRemoved, api.onChildMoved].every(fn => typeof fn === 'function')).toBe(true);
  });
  row('M41', assertInitialAddedChildrenContract);
  row('M42', assertPostSubscribeAddedChildContract);
  row('M43', assertChangedChildContract);
  row('M44', assertChangedChildExcludesAddsAndRemovals);
  row('M45', assertRemovedChildContract);
  row('M46', assertMovedChildContract);
  row('M47', assertOffRemovesEveryListenerVariety);
  row('M48', assertTargetedOffAndUnsubscribe);
  row('M32', () => {
    const { db } = setup(); expect(api.connectDatabaseEmulator(db, 'localhost', 9000)).toBeUndefined();
  });
  row('M33', async () => {
    const { db } = setup(); api.databaseSandbox.setRules(db, { rules: { '.write': false } });
    await expect(api.set(api.ref(db, 'x'), 1)).rejects.toThrow(); api.databaseSandbox.setRules(db, null);
    await api.set(api.ref(db, 'x'), 1); expect((await api.get(api.ref(db, 'x'))).val()).toBe(1);
  });
  row('M34', assertSetDataBypassesRules);
  row('M35', async () => {
    const { db } = setup(); await api.set(api.ref(db, 'a'), 1);
    expect(api.databaseSandbox.snapshotState(db)).toEqual({ a: 1 });
  });
  row('M36', async () => expect(await (async () => {
    const { db } = setup(); await api.set(api.ref(db, 'rows'), { a: 2, b: 1 });
    return (await api.get(api.query(api.ref(db, 'rows'), api.orderByValue()))).size;
  })()).toBe(2));
  row('M37', () => assertTransaction('commit'));
  row('M37a', assertTransactionAbortContract);
  row('M37b', async () => {
    const { db } = setup(); const target = api.ref(db, 'x'); await api.set(target, 1); const seen: unknown[] = [];
    await api.runTransaction(target, current => { seen.push(current); return current; });
    expect(currentValueObservation.seededArgs).toHaveLength(2); expect(seen).toEqual([1]);
  });
  row('M37c', () => assertTransaction('clone'));
  row('M37d', assertApplyLocallyContract);
  row('M37e', assertDeniedTransactionEnvelope);
  row('M37f', () => assertTransaction('denied'));
  row('M37g', () => assertTransaction('listener'));
  row('M37h', assertTransactionContentionBoundary);
  row('M38', async () => {
    const sandbox = initializeSandbox(); const db = api.getDatabase(sandbox); const target = api.ref(db, 'x');
    api.databaseSandbox.setRules(db, { rules: { '.write': 'auth != null', '.read': true } });
    await expect(api.set(target, 1)).rejects.toThrow(); sandbox.currentUser = { uid: 'alice' }; await api.set(target, 1); expect((await api.get(target)).val()).toBe(1);
  });
  row('M39', assertDatabaseBackendIdentity);
  row('M40', assertReferenceShape);
});
