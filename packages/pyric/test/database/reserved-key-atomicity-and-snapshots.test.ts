import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  onValue,
  ref,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from '../../src/database/index.js';

const OPEN_RULES = { rules: { '.read': true, '.write': true } };

describe('reserved prototype keys in writes and snapshot rendering', () => {
  for (const reservedKey of ['constructor', 'prototype', '__proto__']) {
    test(`keeps set() atomic when nested .priority sits under '${reservedKey}'`, async () => {
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

    test(`keeps update() atomic when a child value has nested .priority under '${reservedKey}'`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);
      await set(ref(db, 'items'), { intact: 1 });

      let threw = false;
      try {
        const nested = JSON.parse(`{"${reservedKey}":{"nested":{".value":2,".priority":5}}}`);
        await update(ref(db, 'items'), { other: 99, branch: nested });
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect((await get(ref(db, 'items'))).val()).toEqual({ intact: 1 });
    });

    test(`renders root and parent val()/exportVal() cleanly after plain set() with '${reservedKey}'`, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box);
      rtdbSandbox.setRules(db, OPEN_RULES);

      const payload = JSON.parse(`{"${reservedKey}":{"nested":1},"plain":2}`);
      await setWithPriority(ref(db, 'items'), payload, 7);

      const rootSnap = await get(ref(db));
      const rootVal = rootSnap.val() as Record<string, Record<string, unknown>>;
      const rootExport = rootSnap.exportVal() as Record<string, Record<string, unknown>>;

      expect(rootVal.items.plain).toBe(2);
      expect(rootExport.items['.priority']).toBe(7);
      expect(Object.getPrototypeOf(rootVal.items)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(rootExport.items)).toBe(Object.prototype);

      if (reservedKey !== '__proto__') {
        expect(Object.hasOwn(rootVal.items, reservedKey)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(rootVal.items, reservedKey)?.value).toEqual({ nested: 1 });
        expect(Object.hasOwn(rootExport.items, reservedKey)).toBe(true);
        expect(Object.getOwnPropertyDescriptor(rootExport.items, reservedKey)?.value).toEqual({ nested: 1 });
      }
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
  });
});
