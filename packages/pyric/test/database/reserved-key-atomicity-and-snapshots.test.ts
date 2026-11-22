import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  onChildAdded,
  onDisconnect,
  onValue,
  orderByKey,
  push,
  query,
  ref,
  runTransaction,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from '../../src/database/index.js';

const OPEN_RULES = { rules: { '.read': true, '.write': true } };

describe('reserved prototype keys in writes and snapshot rendering', () => {
  for (const reservedKey of ['constructor', 'prototype', '__proto__']) {
    test(`rejects set() atomically when nested .priority sits under '${reservedKey}'`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);
      await set(ref(db, 'items'), { intact: 1 });

      const observed: unknown[] = [];
      const unsubscribe = onValue(ref(db, 'items'), (snap) => {
        observed.push(snap.val());
      });
      const initialCount = observed.length;

      let threw = false;
      try {
        const payload = JSON.parse(
          `{"${reservedKey}":{"nested":{".value":2,".priority":5}},"other":99}`,
        );
        await set(ref(db, 'items'), payload);
      } catch {
        threw = true;
      } finally {
        unsubscribe();
      }

      expect(threw).toBe(true);
      expect(observed.length).toBe(initialCount);
      expect((await get(ref(db, 'items/intact'))).val()).toBe(1);
      expect((await get(ref(db, 'items/other'))).val()).toBeNull();
    });

    test(`rejects runTransaction() atomically for nested .priority and plain '${reservedKey}' payloads`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);
      await set(ref(db, 'items'), { intact: 1 });

      const plainObserved: unknown[] = [];
      const queryObserved: unknown[] = [];
      const childKeys: Array<string | null> = [];
      const unsubs = [
        onValue(ref(db, 'items'), (snap) => {
          plainObserved.push(snap.val());
        }),
        onValue(query(ref(db, 'items'), orderByKey()), (snap) => {
          queryObserved.push(snap.val());
        }),
        onChildAdded(ref(db, 'items'), (snap) => {
          childKeys.push(snap.key);
        }),
      ];

      try {
        const plainBefore = plainObserved.length;
        const queryBefore = queryObserved.length;
        const childBefore = childKeys.length;

        const withPriority = JSON.parse(
          `{"${reservedKey}":{"nested":{".value":2,".priority":5}},"other":99}`,
        );
        expect(() =>
          runTransaction(ref(db, 'items'), () => withPriority),
        ).toThrow(`Invalid RTDB path segment '${reservedKey}'`);

        const plainPayload = JSON.parse(`{"${reservedKey}":1,"other":99}`);
        expect(() =>
          runTransaction(ref(db, 'items'), () => plainPayload),
        ).toThrow(`Invalid RTDB path segment '${reservedKey}'`);

        expect((await get(ref(db, 'items'))).val()).toEqual({ intact: 1 });
        expect(plainObserved.length).toBe(plainBefore);
        expect(queryObserved.length).toBe(queryBefore);
        expect(childKeys.length).toBe(childBefore);
      } finally {
        for (const unsub of unsubs) unsub();
      }
    });

    test(`keeps set() atomic with active query and child listeners and keeps reads and forEach healthy for '${reservedKey}'`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);
      await set(ref(db, 'items'), { intact: 1 });

      const queryVals: unknown[] = [];
      const childEvents: Array<string | null> = [];
      const unsubs = [
        onValue(query(ref(db, 'items'), orderByKey()), (snap) => {
          queryVals.push(snap.val());
        }),
        onChildAdded(ref(db, 'items'), (snap) => {
          childEvents.push(snap.key);
        }),
      ];

      try {
        const queryBefore = queryVals.length;
        const childBefore = childEvents.length;

        const payload = JSON.parse(`{"${reservedKey}":1,"other":99}`);
        expect(() => set(ref(db, 'items'), payload)).toThrow(
          `Invalid RTDB path segment '${reservedKey}'`,
        );

        expect(queryVals.length).toBe(queryBefore);
        expect(childEvents.length).toBe(childBefore);
        expect((await get(ref(db, 'items'))).val()).toEqual({ intact: 1 });

        const rootSnap = await get(ref(db));
        expect(rootSnap.val()).toEqual({ items: { intact: 1 } });
        expect(rootSnap.exportVal()).toEqual({ items: { intact: 1 } });
        const rootChildren: Array<string | null> = [];
        rootSnap.forEach((childSnap) => {
          rootChildren.push(childSnap.key);
        });
        expect(rootChildren).toEqual(['items']);

        const querySnap = await get(query(ref(db, 'items'), orderByKey()));
        expect(querySnap.val()).toEqual({ intact: 1 });
        const queryChildren: Array<string | null> = [];
        querySnap.forEach((childSnap) => {
          queryChildren.push(childSnap.key);
        });
        expect(queryChildren).toEqual(['intact']);

        await set(ref(db, 'items/added'), 2);
        expect(queryVals.at(-1)).toEqual({ intact: 1, added: 2 });
        expect(childEvents.at(-1)).toBe('added');
      } finally {
        for (const unsub of unsubs) unsub();
      }
    });

    test(`rejects '${reservedKey}' across setWithPriority, update, push, and onDisconnect without mutating existing data`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);
      await set(ref(db, 'items'), { intact: 1 });

      const reservedOnly = JSON.parse(`{"${reservedKey}":{"a":1}}`);
      const withNestedPriority = JSON.parse(
        `{"${reservedKey}":{"nested":{".value":2,".priority":5}}}`,
      );

      expect(() => set(ref(db, 'items'), reservedOnly)).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => setWithPriority(ref(db, 'items'), reservedOnly, 7)).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => push(ref(db, 'items'), reservedOnly)).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => update(ref(db, 'items'), { other: 99, branch: reservedOnly })).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => update(ref(db, 'items'), { other: 99, branch: withNestedPriority })).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => onDisconnect(ref(db, 'items')).set(reservedOnly)).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => onDisconnect(ref(db, 'items')).setWithPriority(reservedOnly, 7)).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );
      expect(() => onDisconnect(ref(db, 'items')).update({ branch: reservedOnly })).toThrow(
        `Invalid RTDB path segment '${reservedKey}'`,
      );

      expect((await get(ref(db, 'items'))).val()).toEqual({ intact: 1 });
      expect((Object.prototype as Record<string, unknown>).a).toBeUndefined();
    });
  }

  test('renders own __proto__ keys from restored snapshots without crashing or mutating prototypes', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box);
    const protoContainer: Record<string, unknown> = { plain: 2 };
    Object.defineProperty(protoContainer, '__proto__', {
      value: { tag: 'preserved' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    box.loadSnapshot({
      firestore: {},
      services: {
        rtdb: {
          '.pyricRtdbPersistence': 1,
          data: { items: protoContainer },
          priorities: { '/items': 7 },
          rules: OPEN_RULES,
        },
      },
    });

    const rootSnap = await get(ref(db));
    const rootVal = rootSnap.val() as Record<string, Record<string, unknown>>;
    const rootExport = rootSnap.exportVal() as Record<string, Record<string, unknown>>;

    expect(Object.hasOwn(rootVal.items, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(rootVal.items, '__proto__')?.value).toEqual({ tag: 'preserved' });
    expect(Object.getPrototypeOf(rootVal.items)).toBe(Object.prototype);

    expect(Object.hasOwn(rootExport.items, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(rootExport.items, '__proto__')?.value).toEqual({ tag: 'preserved' });
    expect(rootExport.items['.priority']).toBe(7);
    expect(Object.getPrototypeOf(rootExport.items)).toBe(Object.prototype);

    const querySnap = await get(query(ref(db, 'items'), orderByKey()));
    const queryVal = querySnap.val() as Record<string, unknown>;
    expect(Object.hasOwn(queryVal, '__proto__')).toBe(true);
    expect(queryVal.plain).toBe(2);
    expect(Object.getPrototypeOf(queryVal)).toBe(Object.prototype);
  });
});
