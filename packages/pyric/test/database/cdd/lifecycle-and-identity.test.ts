import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from '../../../src/app/index.js';
import { bindAppRegistryRefusal, resetAppRegistryForTests } from '../../../src/app/registry.js';
import { clientSdkRefusal, clientSdkRefusalFor } from '../../../src/app/client-sdk-refusal.js';
import {
  TARGET_SYMBOL,
  api,
  assertChildEvent,
  assertDisconnectCleanSet,
  assertDisconnectDeferred,
  assertDisconnectOperations,
  assertDisconnectPriority,
  assertDisconnectRegistration,
  assertDisconnectRules,
  assertPriority,
  assertReferenceShape,
  assertSnapshotShape,
  assertTransaction,
  keys,
  setup,
  type DisconnectCleanSetObservation,
  type DisconnectOperationOutcomes,
  type DisconnectRegistrationObservation,
  type DisconnectRulesObservation,
} from './support.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';
import { getAdminDatabase, getDatabase, sandbox as rtdbSandbox } from '../../../src/database/index.js';
import { heldDatabaseInstances } from '../../../src/database/internal.js';
import { replay } from '../../../src/database/replay.js';
import {
  UNNAMED_DEFAULT_DATABASE_INSTANCE,
  databaseInstanceKey,
  databaseInstanceNamed,
  parseDatabaseUrl,
  resolveDatabaseInstance,
} from '../../../src/sandbox/internal/instances.js';

const abruptObservation = loadObservation('rtdb-modular-ondisconnect-abrupt-exit');
const cleanDisconnectObservation = loadObservation('rtdb-modular-ondisconnect-clean-set');
const disconnectOperationsObservation = loadObservation('rtdb-modular-ondisconnect-operations-cancel');
const disconnectRegistrationObservation = loadObservation('rtdb-modular-ondisconnect-registration');
const disconnectRulesObservation = loadObservation('rtdb-modular-ondisconnect-rules');
const referenceObservation = loadObservation('rtdb-modular-reference-shape-url');
const runtimeIdentityObservation = loadObservation('rtdb-modular-runtime-class-identity');
const queryValidationObservation = loadObservation('rtdb-modular-query-construction-validation');
const priorityObservation = loadObservation('rtdb-modular-priority-contract');
const offObservation = loadObservation('rtdb-modular-off-duplicate-registration');
const snapshotObservation = loadObservation('rtdb-modular-get-snapshot-shape');

const row = (id: string, assertion: () => unknown | Promise<unknown>) => it(`rtdb-modular#${id}`, assertion);

describe('rtdb-modular CDD: lifecycle and runtime identity rows', () => {
  beforeEach(() => resetAppRegistryForTests());
  afterEach(() => resetAppRegistryForTests());

  row('M77', () => assertDisconnectRegistration(
    disconnectRegistrationObservation as DisconnectRegistrationObservation,
  ));
  row('M78', () => assertDisconnectDeferred(disconnectRegistrationObservation.unchangedAfterRegistration));
  row('M79', () => assertDisconnectCleanSet(cleanDisconnectObservation as DisconnectCleanSetObservation));
  row('M80', () => assertDisconnectOperations(
    disconnectOperationsObservation.outcomes as DisconnectOperationOutcomes,
    disconnectOperationsObservation.observerSawDisconnectEvents,
  ));
  row('M81', () => assertDisconnectRules(disconnectRulesObservation as DisconnectRulesObservation));
  row('M82', async () => {
    const sandbox = initializeSandbox();
    const first = api.getDatabase(sandbox.withAuth({ uid: 'first' }));
    const second = api.getDatabase(sandbox.withAuth({ uid: 'second' }));
    api.databaseSandbox.setDefaultPolicy(first, 'allow');
    const target = api.ref(first, 'presence/client');
    await api.set(target, 'online');
    await api.onDisconnect(target).set('offline');

    expect(api.databaseSandbox.snapshotState(first)).toEqual({ presence: { client: 'online' } });
    api.goOffline(second);
    expect((await api.get(target)).val()).toBe('online');
    sandbox.reset();
    api.goOffline(first);
    expect((await api.get(target)).val()).toBe('online');

    const writer = initializeApp({ projectId: 'cdd-m82' }, 'cdd-m82-writer');
    const writerDb = api.getDatabase(writer);
    api.databaseSandbox.setDefaultPolicy(writerDb, 'allow');
    const writerTarget = api.ref(writerDb, 'presence/app');
    await api.set(writerTarget, 'online');
    await api.onDisconnect(writerTarget).set('offline');
    await deleteApp(writer);
    const observer = initializeApp({ projectId: 'cdd-m82' }, 'cdd-m82-observer');
    const observerDb = api.getDatabase(observer);
    api.databaseSandbox.setDefaultPolicy(observerDb, 'allow');
    expect((await api.get(api.ref(observerDb, 'presence/app'))).val()).toBe('offline');
    await deleteApp(observer);
  });
  row('M83', () => assertDisconnectPriority(disconnectOperationsObservation.outcomes.setWithPriority));
  row('M84', async () => {
    expect(abruptObservation.acknowledgement).toEqual({ registered: true });
    expect(abruptObservation.events).toEqual([{ state: 'online' }, { state: 'offline' }]);
    expect(abruptObservation.exitWasForced).toBe(true);
    expect(abruptObservation.terminal).toEqual({ state: 'offline' });

    // The in-process sandbox has no process-loss signal: an acknowledged
    // registration remains pending until one of its deterministic clean
    // lifecycle hooks runs. Worker pagehide/port-close coverage lives in the
    // served two-port integration named by the M84 registry row.
    const { db } = setup();
    const target = api.ref(db, 'abrupt-boundary');
    await api.set(target, { state: 'online' });
    await api.onDisconnect(target).set({ state: 'offline' });
    await Promise.resolve();
    expect((await api.get(target)).val()).toEqual({ state: 'online' });
    api.goOffline(db);
    expect((await api.get(target)).val()).toEqual(abruptObservation.terminal);
  });
  row('M85', () => {
    const { db } = setup();
    expect(runtimeIdentityObservation.database).toMatchObject({ constructorName: 'Database', instanceOf: true, prototypeIsExportPrototype: true });
    expect([db.constructor.name, db instanceof api.Database, Object.getPrototypeOf(db)]).toEqual(['Database', true, api.Database.prototype]);
  });
  row('M86', async () => {
    await assertSnapshotShape(); const { db } = setup(); const snapshot = await api.get(api.ref(db));
    expect(runtimeIdentityObservation.snapshot).toMatchObject({ constructorName: 'DataSnapshot', instanceOf: true, prototypeIsExportPrototype: true });
    expect([snapshot.constructor.name, snapshot instanceof api.DataSnapshot, Object.getPrototypeOf(snapshot)]).toEqual(['DataSnapshot', true, api.DataSnapshot.prototype]);
  });
  row('M87', () => {
    const constraints = {
      orderByChild: api.orderByChild('value'), orderByKey: api.orderByKey(),
      orderByPriority: api.orderByPriority(), orderByValue: api.orderByValue(),
      startAt: api.startAt(1), startAfter: api.startAfter(1), endAt: api.endAt(1),
      endBefore: api.endBefore(1), equalTo: api.equalTo(1),
      limitToFirst: api.limitToFirst(1), limitToLast: api.limitToLast(1),
    };
    expect(runtimeIdentityObservation.queryConstraint).toMatchObject({ instanceOf: true, prototypeIsExportPrototype: false });
    expect(Object.fromEntries(Object.entries(constraints).map(([name, value]) => [name, {
      constructorName: value.constructor.name,
      instanceOf: value instanceof api.QueryConstraint,
      prototypeIsExportPrototype: Object.getPrototypeOf(value) === api.QueryConstraint.prototype,
      prototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(value) as object).sort(),
    }]))).toEqual(runtimeIdentityObservation.constraintFactories);
  });
  row('M88', async () => {
    await assertTransaction('commit'); const { db } = setup(); const result = await api.runTransaction(api.ref(db, 'identity'), () => 1);
    expect(runtimeIdentityObservation.transactionResult).toMatchObject({ constructorName: 'TransactionResult', instanceOf: true, prototypeIsExportPrototype: true, toJSONType: 'function' });
    expect([result.constructor.name, result instanceof api.TransactionResult, Object.getPrototypeOf(result), result.toJSON()]).toEqual(['TransactionResult', true, api.TransactionResult.prototype, { committed: true, snapshot: 1 }]);
  });
  row('M89', async () => {
    await assertPriority();
    const { db } = setup(); const target = api.ref(db, 'priority-contract/value');
    await api.setWithPriority(target, { value: 1 }, 10);
    expect((await api.get(target)).exportVal()).toEqual(priorityObservation.before[0].exportVal);
    await api.update(target, { value: 2 }); expect((await api.get(target)).priority).toBe(10);
    await api.runTransaction(target, current => ({ value: (current as { value: number }).value + 1 }));
    expect((await api.get(target)).priority).toBe(10);
    await api.set(target, { value: 4 }); expect((await api.get(target)).priority).toBeNull();
    await api.setPriority(target, 'later'); expect((await api.get(target)).priority).toBe('later');
    await api.setPriority(target, null); expect((await api.get(target)).exportVal()).toEqual({ value: 4 });
    await expect(api.setPriority(target, Number.NaN)).rejects.toThrow(/priority/);
    await expect(api.setWithPriority(target, 1, Number.NaN)).rejects.toThrow(/priority/);

    const parent = api.ref(db, 'priority-contract/children');
    await api.setWithPriority(api.child(parent, 'a'), { value: 1 }, 10);
    await api.setWithPriority(api.child(parent, 'b'), { value: 2 }, 5);
    await api.setWithPriority(api.child(parent, 'c'), { value: 3 }, 5);
    expect((await api.get(parent)).exportVal()).toEqual(priorityObservation.parentExportVal);
    expect((await api.get(parent)).toJSON()).toEqual(priorityObservation.parentToJSON);
  });
  row('M90', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows');
    await api.setWithPriority(api.child(parent, 'a'), { value: 1 }, 10);
    await api.setWithPriority(api.child(parent, 'b'), { value: 2 }, 5);
    await api.setWithPriority(api.child(parent, 'c'), { value: 3 }, 5);
    expect(keys(await api.get(parent))).toEqual(priorityObservation.plainForEachKeys);
    expect(keys(await api.get(api.query(parent, api.limitToFirst(2))))).toEqual(priorityObservation.defaultLimitedKeys);
    expect(keys(await api.get(api.query(parent, api.orderByPriority())))).toEqual(priorityObservation.orderedKeys);
    expect(keys(await api.get(api.query(parent, api.orderByPriority(), api.startAt(5), api.limitToFirst(2))))).toEqual(priorityObservation.boundedKeys);
    expect(keys(await api.get(api.query(parent, api.orderByPriority(), api.equalTo(5))))).toEqual(priorityObservation.equalKeys);
    expect(keys(await api.get(api.query(parent, api.orderByPriority(), api.endAt(5))))).toEqual(['b', 'c']);
    expect(keys(await api.get(api.query(parent, api.orderByPriority(), api.limitToLast(2))))).toEqual(['c', 'a']);
    for (const invalid of [false, { invalid: true }]) {
      expect(() => api.query(parent, api.orderByPriority(), api.startAt(invalid as never))).toThrow(priorityObservation.invalidPriorityBounds.boolean.message);
      expect(() => api.query(parent, api.startAt(invalid as never))).toThrow(priorityObservation.invalidPriorityBounds.defaultBoolean.message);
    }
  });
  row('M91', async () => {
    await assertChildEvent('moved');
    const { db } = setup(); const parent = api.ref(db, 'priority-move');
    await api.setWithPriority(api.child(parent, 'a'), { value: 1 }, 10);
    await api.setWithPriority(api.child(parent, 'b'), { value: 2 }, 5);
    await api.setWithPriority(api.child(parent, 'c'), { value: 3 }, 5);
    const moved: Array<[string | null, string | null]> = []; let values = 0;
    api.onChildMoved(api.query(parent, api.orderByPriority()), (snap, previous) => moved.push([snap.key, previous]));
    api.onValue(api.query(parent, api.orderByPriority()), () => values++);
    await api.setPriority(api.child(parent, 'a'), 0);
    expect(moved).toEqual(priorityObservation.moved); expect(values).toBe(priorityObservation.orderedValueDeliveriesAfterMove);
    await api.update(api.child(parent, 'a'), { value: 4 }); expect((await api.get(api.child(parent, 'a'))).priority).toBe(priorityObservation.afterUpdate);
    await api.runTransaction(api.child(parent, 'a'), current => ({ value: (current as { value: number }).value + 1 }));
    expect((await api.get(api.child(parent, 'a'))).priority).toBe(priorityObservation.afterTransaction);
    await api.onDisconnect(api.child(parent, 'a')).update({ value: 9 }); api.goOffline(db);
    expect([(await api.get(api.child(parent, 'a'))).val(), (await api.get(api.child(parent, 'a'))).priority]).toEqual([{ value: 9 }, 0]);
  });
  row('M92', async () => {
    const { db } = setup(); const parent = api.ref(db, 'rows'); const ordered = api.query(parent, api.orderByChild('rank'), api.limitToFirst(2));
    const counts = { defaultCount: 0, orderedCount: 0 };
    api.onValue(parent, () => counts.defaultCount++); api.onValue(ordered, () => counts.orderedCount++);
    api.off(api.query(parent, api.limitToFirst(2), api.orderByChild('rank')));
    await api.set(parent, { a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    expect(counts).toEqual(offObservation.queryScope.afterQueryOff);
    api.onValue(ordered, () => counts.orderedCount++); api.off(parent);
    const afterReferenceOff = { ...counts };
    await api.update(parent, { 'a/rank': 4 });
    expect(counts).toEqual(afterReferenceOff);

    let defaultFires = 0; api.onValue(parent, () => defaultFires++);
    api.off(api.query(parent)); await api.update(parent, { 'b/rank': 5 });
    expect(defaultFires).toBe(1);
  });
  row('M93', () => {
    const first = setup(); const second = setup(); const a = api.ref(first.db, 'a');
    const q = api.query(a, api.orderByValue(), api.startAt(1), api.endAt(2));
    const equivalent = api.query(a, api.endAt(2), api.orderByValue(), api.startAt(1));
    expect(referenceObservation.queryIdentity.referenceToJSON.protocol).toBe('https:');
    expect({ sameReference: a.isEqual(api.ref(first.db, 'a')), defaultQueryEqualsReference: a.isEqual(api.query(a)),
      referenceEqualsDefaultQuery: api.query(a).isEqual(a), equivalentConstraintOrder: q.isEqual(equivalent),
      differentSpec: q.isEqual(api.query(a, api.orderByValue(), api.startAt(2))), differentPath: a.isEqual(api.ref(first.db, 'b')),
      differentApp: a.isEqual(api.ref(second.db, 'a')), nullValue: a.isEqual(null), nonQuery: a.isEqual({} as never),
    }).toEqual(Object.fromEntries(Object.entries(referenceObservation.queryIdentity).filter(([key]) => !key.endsWith('ToJSON'))));
    expect([a.toJSON(), q.toJSON()]).toEqual(['sandbox://rtdb/a', 'sandbox://rtdb/a']);
  });
  row('M94', () => {
    const { db } = setup(); const target = api.ref(db, 'rows');
    expect(queryValidationObservation).toMatchObject({ repeatCount: 2, contractDigest: 'd8e121139846b37dec3df876f9f26256af5b32459377dc4ecfac7a01c2a1f362' });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '1' as never]) expect(() => api.limitToFirst(invalid)).toThrow();
    expect(() => api.limitToFirst(Number.POSITIVE_INFINITY)).not.toThrow();
    for (const invalid of ['$key', '$priority', '$value', '', 'bad#path', 'bad.path']) expect(() => api.orderByChild(invalid)).toThrow();
    expect(() => api.query(target, api.orderByKey(), api.startAt({} as never))).toThrow();
    expect(() => api.query(target, api.orderByPriority(), api.startAt(api.serverTimestamp() as never))).not.toThrow();
  });

  row('94', () => {
    const sandbox = initializeSandbox(); const db = api.getDatabase(sandbox.withAuth({ uid: 'x' }));
    expect(db[TARGET_SYMBOL]).toMatchObject({ kind: 'sandbox', auth: { uid: 'x' } });
  });
  row('95', () => {
    const sandbox = initializeSandbox(); const db = api.getDatabase(sandbox);
    const second = api.getDatabase(sandbox);
    expect(db[TARGET_SYMBOL].kind).toBe('sandbox-live'); expect(second[TARGET_SYMBOL].backend).toBe(db[TARGET_SYMBOL].backend);
  });
  row('96', () => expect(() => api.getDatabase({} as never)).toThrow(/package resolution/i));
  row('97', () => expect(() => api.getDatabase()).toThrow(/default sandbox app registry|no firebase app|package resolution/i));
  row('98', async () => {
    const sandbox = initializeSandbox(); const a = api.getDatabase(sandbox); const b = api.getDatabase(sandbox); api.databaseSandbox.setDefaultPolicy(a, 'allow'); await api.set(api.ref(a, 'x'), 1);
    expect((await api.get(api.ref(b, 'x'))).val()).toBe(1);
  });
  row('99', async () => {
    const a = api.getDatabase(initializeSandbox().withAuth({ uid: 'a' })); const b = api.getDatabase(initializeSandbox().withAuth({ uid: 'b' })); api.databaseSandbox.setDefaultPolicy(a, 'allow'); api.databaseSandbox.setDefaultPolicy(b, 'allow'); await api.set(api.ref(a, 'x'), 1); await api.set(api.ref(b, 'x'), 2);
    expect([(await api.get(api.ref(a, 'x'))).val(), (await api.get(api.ref(b, 'x'))).val()]).toEqual([1, 2]);
    expect(api.ref(a, 'x').isEqual(api.ref(b, 'x'))).toBe(false);
  });
  row('100', async () => {
    await assertReferenceShape(); const { db } = setup();
    for (const path of ['bad.path', 'bad#path', 'bad$path', 'bad[path', 'bad]path']) expect(() => api.ref(db, path)).toThrow('invalid path');
  });
  row('101', () => { const { db } = setup(); const root = api.ref(db); expect([root.key, root.parent]).toEqual([null, null]); });
  row('102', () => { const { db } = setup(); const nested = api.child(api.ref(db, 'a'), 'b/c'); expect([nested.key, nested.parent?.key, nested.toString()]).toEqual(['c', 'b', api.ref(db, 'a/b/c').toString()]); for (const path of ['', 'bad#path', 'bad.path']) expect(() => api.child(api.ref(db), path)).toThrow('invalid path'); });
  row('103', () => { const { db } = setup(); expect([api.ref(db).parent, api.ref(db, 'a/b').parent?.key]).toEqual([null, 'a']); });
  row('104', () => { const { db } = setup(); expect([api.ref(db).key, api.ref(db, 'a/b').key]).toEqual([null, 'b']); });
  row('105', () => { let error: unknown; try { void api.get({} as never); } catch (caught) { error = caught; } expect(error).toBeInstanceOf(TypeError); });
  row('106', async () => {
    await assertSnapshotShape(); const { db } = setup(); const target = api.ref(db, 'parent');
    await api.set(target, { a: 1, b: 2, c: 3 }); const snap = await api.get(target); const forEachKeys: string[] = [];
    snap.forEach(child => { forEachKeys.push(child.key!); return false; });
    expect({ hasVal: typeof snap.val === 'function', hasExists: typeof snap.exists === 'function', hasKey: 'key' in snap,
      hasRef: 'ref' in snap, hasSize: 'size' in snap, hasHasChildren: typeof snap.hasChildren === 'function',
      hasHasChild: typeof snap.hasChild === 'function', hasForEach: typeof snap.forEach === 'function',
      hasNumChildren: 'numChildren' in snap, size: snap.size, hasChildrenResult: snap.hasChildren(), existsResult: snap.exists(),
      val: snap.val(), forEachKeys, key: snap.key,
    }).toEqual(Object.fromEntries(Object.entries(snapshotObservation).filter(([key]) => !['threw', 'code', 'message'].includes(key))));
  });
  row('107', async () => { const { db } = setup(); expect((await api.get(api.ref(db, 'missing'))).val()).toBeNull(); });
  row('108', async () => { const { db } = setup(); const target = api.ref(db, 'x'); expect((await api.get(target)).exists()).toBe(false); await api.set(target, 0); expect((await api.get(target)).exists()).toBe(true); });
});

// The MI rows record how each Pyric path serves multiple database instances;
// the CLI and pyric-admin suites the rows name pin each path. These
// assertions pin the sandbox side of the boundary: the in-page sandbox keeps
// one backend, one ruleset, and one canonical key per instance.
describe('rtdb-modular CDD: multiple database instances', () => {
  const FIRST = 'https://first.firebaseio.com';
  const SECOND = 'https://second.firebaseio.com';

  row('MI1', async () => {
    const sandbox = initializeSandbox();
    const first = api.getDatabase(sandbox, FIRST);
    const second = api.getDatabase(sandbox, SECOND);
    api.databaseSandbox.setDefaultPolicy(first, 'allow');
    api.databaseSandbox.setDefaultPolicy(second, 'allow');
    await api.set(api.ref(first, 'probe'), 'first');
    expect((await api.get(api.ref(second, 'probe'))).exists()).toBe(false);
    expect((await api.get(api.ref(api.getDatabase(sandbox, FIRST), 'probe'))).val()).toBe('first');

    // The project's default instance URL opens the default instance, as
    // `getDatabase(app)` does in production.
    const byUrl = initializeApp({ projectId: 'cdd-mi1' }, 'cdd-mi1-url');
    const implicit = initializeApp({ projectId: 'cdd-mi1' }, 'cdd-mi1-implicit');
    const urlDb = api.getDatabase(byUrl, 'https://cdd-mi1-default-rtdb.firebaseio.com');
    api.databaseSandbox.setDefaultPolicy(urlDb, 'allow');
    await api.set(api.ref(urlDb, 'shared'), 'by url');
    expect((await api.get(api.ref(api.getDatabase(implicit), 'shared'))).val()).toBe('by url');
    await deleteApp(byUrl);
    await deleteApp(implicit);
  });
  row('MI2', async () => {
    const sandbox = initializeSandbox();
    const first = api.getDatabase(sandbox, FIRST);
    const second = api.getDatabase(sandbox, SECOND);
    api.databaseSandbox.setRules(first, { rules: { '.read': true } });
    api.databaseSandbox.setRules(second, { rules: { '.read': false } });
    expect((await api.get(api.ref(first, 'probe'))).exists()).toBe(false);
    await expect(api.get(api.ref(second, 'probe'))).rejects.toThrow('PERMISSION_DENIED');
  });
  row('MI3', () => {
    expect(databaseInstanceNamed('first')).toEqual(parseDatabaseUrl(FIRST));
    expect(parseDatabaseUrl(`${FIRST}/`)).toEqual({ name: 'first', url: `${FIRST}/` });
    expect(databaseInstanceKey(resolveDatabaseInstance(undefined))).toBe(UNNAMED_DEFAULT_DATABASE_INSTANCE);
  });
  row('MI4', async () => {
    const sandbox = initializeSandbox();
    await api.set(api.ref(getAdminDatabase(sandbox, FIRST), 'probe'), 'first');
    expect((await api.get(api.ref(getAdminDatabase(sandbox, SECOND), 'probe'))).exists()).toBe(false);
    expect((await api.get(api.ref(getAdminDatabase(sandbox, FIRST), 'probe'))).val()).toBe('first');
  });
  row('MI5', async () => {
    // The database tool resolves its `instance` argument with the SDK's rules:
    // every form of one name reaches one instance, `default` the default one,
    // and the sandbox names each instance it holds, so an unknown one is refused.
    for (const form of ['first', 'FIRST', FIRST, `${FIRST}/`, 'http://localhost:9000/?ns=first']) {
      expect(resolveDatabaseInstance(form)?.name).toBe('first');
    }
    expect(resolveDatabaseInstance('default')).toBeUndefined();
    expect(() => resolveDatabaseInstance(`${FIRST}/probe`)).toThrow('Database URL must point to the root');
    const sandbox = initializeSandbox();
    await api.set(api.ref(getAdminDatabase(sandbox), 'probe'), 'default');
    expect(heldDatabaseInstances(sandbox)).toEqual([]);
    await api.set(api.ref(getAdminDatabase(sandbox, 'first'), 'probe'), 'first');
    expect(heldDatabaseInstances(sandbox)).toEqual(['first']);
    expect((await api.get(api.ref(getAdminDatabase(sandbox, FIRST), 'probe'))).val()).toBe('first');
  });
  row('MI6', async () => {
    // `pyric verify` replays each instance on its own: only the events it
    // emitted, into its own captured tree, under its own candidate rules.
    const open = { rules: { '.read': true, '.write': true } };
    const sandbox = initializeSandbox();
    rtdbSandbox.setRules(getDatabase(sandbox), open);
    rtdbSandbox.setRules(getDatabase(sandbox, FIRST), open);
    const alice = sandbox.withAuth({ uid: 'alice' });
    await api.set(api.ref(getDatabase(alice), 'probe'), 'default');
    await api.set(api.ref(getDatabase(alice, FIRST), 'probe'), 'first');
    const history = sandbox.history();
    const firstState = rtdbSandbox.snapshotState(getAdminDatabase(sandbox, FIRST));
    const defaultState = rtdbSandbox.snapshotState(getAdminDatabase(sandbox));

    const clean = await replay(history, { rules: open, instance: 'first', capturedState: firstState });
    expect(clean).toMatchObject({ ok: true, checkedEvents: 1, divergences: [] });
    const locked = { rules: { '.read': true, '.write': false } };
    const denied = await replay(history, { rules: locked, instance: FIRST, capturedState: firstState });
    expect(denied.divergences.filter((divergence) => divergence.kind === 'now-denied')).toEqual([
      expect.objectContaining({ path: '/probe', method: 'set' }),
    ]);
    const unaffected = await replay(history, { rules: open, capturedState: defaultState });
    expect(unaffected).toMatchObject({ ok: true, checkedEvents: 1 });
  });
});

// Rows VR1 to VR3 record what `pyric verify` checks when it replays a captured
// RTDB session; the replay and verify suites and the app scenario the rows
// name pin the CLI path. These assertions pin the sandbox side: the events the
// backend records and the replay verdicts on them.
describe('rtdb-modular CDD: verifying a captured session', () => {
  const OWNER = { rules: { profiles: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } } };
  const OPEN = { rules: { '.read': true, '.write': true } };

  async function capture(run: (db: ReturnType<typeof getDatabase>) => Promise<unknown>) {
    const sandbox = initializeSandbox();
    rtdbSandbox.setRules(getDatabase(sandbox), OWNER);
    rtdbSandbox.setData(getAdminDatabase(sandbox), { '/profiles/alice': 'a', '/profiles/bob': 'b' });
    await run(getDatabase(sandbox.withAuth({ uid: 'alice' })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { history: sandbox.history(), state: rtdbSandbox.snapshotState(getAdminDatabase(sandbox)) };
  }

  row('VR1', async () => {
    const { history, state } = await capture(async (db) => {
      await api.get(api.ref(db, 'profiles/alice'));
      const off = api.onValue(api.ref(db, 'profiles/alice'), () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      off();
    });
    expect((await replay(history, { rules: OWNER, capturedState: state })).divergences).toEqual([]);
    const noReads = { rules: { profiles: { $uid: { '.write': 'auth.uid === $uid' } } } };
    const denied = await replay(history, { rules: noReads, capturedState: state });
    expect(denied.divergences.map(({ kind, method, path }) => ({ kind, method, path }))).toEqual([
      { kind: 'now-denied', method: 'get', path: '/profiles/alice' },
      { kind: 'now-denied', method: 'listen', path: '/profiles/alice' },
    ]);
  });

  row('VR2', async () => {
    const { history, state } = await capture((db) => api.set(api.ref(db, 'profiles/bob'), 'mallory').catch(() => {}));
    expect((await replay(history, { rules: OWNER, capturedState: state })).divergences).toEqual([]);
    const opened = await replay(history, { rules: OPEN, capturedState: state });
    expect(opened.divergences.map(({ kind, method, path }) => ({ kind, method, path }))).toEqual([
      { kind: 'now-allowed', method: 'set', path: '/profiles/bob' },
    ]);
    expect(opened.replayedState).toEqual(state);
  });

  row('VR3', async () => {
    const { history, state } = await capture(async (db) => {
      await api.onDisconnect(api.ref(db, 'profiles/alice')).set('gone');
    });
    const operations = history.filter((event) => event.kind === 'operation');
    expect(operations.map((event) => ({ method: event.method, path: event.path, result: event.result }))).toEqual([
      { method: 'onDisconnect.set', path: '/profiles/alice', result: 'allow' },
    ]);
    expect((await replay(history, { rules: OWNER, capturedState: state })).divergences).toEqual([]);
    const readOnly = { rules: { '.read': true, '.write': false } };
    const denied = await replay(history, { rules: readOnly, capturedState: state });
    expect(denied.divergences.map(({ kind, method, path }) => ({ kind, method, path }))).toEqual([
      { kind: 'now-denied', method: 'onDisconnect.set', path: '/profiles/alice' },
    ]);
  });
});

// Row HD1 records what the web hosted client does with a call in flight when
// its socket drops; the CLI suites and the app scenario the row names pin that
// path. This assertion pins the sandbox side of the boundary: the in-page
// sandbox has no socket, so a write, an onDisconnect registration and a
// transaction issued around goOffline() and goOnline() each settle in process.
describe('rtdb-modular CDD: calls in flight at a hosted connection drop', () => {
  row('HD1', async () => {
    const { db } = setup();
    const room = api.ref(db, 'rooms/r1');
    const write = api.set(room, 'written across the drop');
    const arm = api.onDisconnect(api.ref(db, 'status/alice')).set('offline');
    const counter = api.runTransaction(api.ref(db, 'counter'), (count: number | null) => (count ?? 0) + 1);
    api.goOffline(db);
    api.goOnline(db);
    await expect(write).resolves.toBeUndefined();
    await expect(arm).resolves.toBeUndefined();
    expect((await counter).committed).toBe(true);
    expect((await api.get(room)).val()).toBe('written across the drop');
  });

  // Row HD2 records the same drop on the Node remote client, which sends
  // these calls again after it reconnects, as the SDK does;
  // packages/cli/test/remote and test/apps/node-client-host-restart pin that
  // path. The sandbox side is the one HD1 pins for a write and a get.
  row('HD2', async () => {
    const { db } = setup();
    const room = api.ref(db, 'rooms/r2');
    const write = api.set(room, 'written from Node');
    api.goOffline(db);
    api.goOnline(db);
    await expect(write).resolves.toBeUndefined();
    expect((await api.get(room)).val()).toBe('written from Node');
  });
  // pyric-admin and the worker bridge iterate an array value by index;
  // their own tests pin those planes. The sandbox side is an admin handle's
  // array read, which keeps one child per index.
  row('AS1', async () => {
    const target = api.ref(getAdminDatabase(initializeSandbox()), 'ticks');
    await api.set(target, ['a', 'b', 'c']);
    const snap = await api.get(target);
    expect(snap.val()).toEqual(['a', 'b', 'c']);
    expect([snap.size, snap.hasChildren(), keys(snap), snap.child('1').val()]).toEqual([3, true, ['0', '1', '2'], 'b']);
  });

  // Row RS1 records the client SDKs in a server process that
  // @pyric/cli/register activated against the Node host (#1082): their calls
  // run under that process's own signed-in session, and an app registry bound
  // to the refusal stands in for any service with no path to the host. The
  // sandbox side: rules evaluate per session as they do for the process on the
  // host, and a refused registry opens no database handle.
  row('RS1', async () => {
    const sandbox = initializeSandbox();
    const rules = { rules: { users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } } };
    rtdbSandbox.setRules(getDatabase(sandbox), rules);
    const alice = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    await expect(api.set(api.ref(alice, 'users/alice'), 'mine')).resolves.toBeUndefined();
    await expect(api.set(api.ref(alice, 'users/bob'), 'theirs')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await resetAppRegistryForTests();
    bindAppRegistryRefusal(() => clientSdkRefusal('remote'));
    try {
      const app = initializeApp({ projectId: 'demo-app' });
      for (const attempt of ['first', 'second']) {
        let code: string | undefined;
        try {
          getDatabase(app);
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        expect(code, attempt).toBe('failed-precondition');
      }
    } finally {
      await resetAppRegistryForTests();
    }
  });

  // Row RS2 records the client SDKs in server-rendered modules under vite dev
  // (#1123): the dev server's in-process activation stands in for
  // PYRIC_SANDBOX, so they run as one SSR session on its host. The sandbox
  // side: rules evaluate per session, and the refusal a service with no path
  // to the host gets names that activation.
  row('RS2', async () => {
    const sandbox = initializeSandbox();
    const rules = { rules: { users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } } };
    rtdbSandbox.setRules(getDatabase(sandbox), rules);
    const session = getDatabase(sandbox.withAuth({ uid: 'ssr-user' }));
    await expect(api.set(api.ref(session, 'users/ssr-user/page'), 'mine')).resolves.toBeUndefined();
    await expect(api.set(api.ref(session, 'users/someone-else/page'), 'theirs')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await resetAppRegistryForTests();
    const label = "the Vite dev server's server-rendered modules";
    bindAppRegistryRefusal(() => clientSdkRefusalFor(label));
    try {
      const app = initializeApp({ projectId: 'demo-app' });
      expect(() => getDatabase(app)).toThrow(label);
    } finally {
      await resetAppRegistryForTests();
    }
  });

  // Row RS3 records firebase-admin in server-rendered modules under vite dev:
  // pyric-admin bound to the dev server's host, as admin. The sandbox side:
  // an admin handle reads and writes past the rules that deny a signed-in user.
  row('RS3', async () => {
    const sandbox = initializeSandbox();
    const rules = { rules: { users: { $uid: { '.read': 'auth.uid === $uid', '.write': 'auth.uid === $uid' } } } };
    rtdbSandbox.setRules(getDatabase(sandbox), rules);
    const admin = getAdminDatabase(sandbox);
    await expect(api.set(api.ref(admin, 'users/ssr-user/page'), 'from admin')).resolves.toBeUndefined();
    expect((await api.get(api.ref(admin, 'users/ssr-user/page'))).val()).toBe('from admin');
    const stranger = getDatabase(sandbox.withAuth({ uid: 'someone-else' }));
    await expect(api.get(api.ref(stranger, 'users/ssr-user/page'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
