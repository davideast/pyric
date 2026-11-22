import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as api from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  return api.getDatabase(sandbox.withAuth({ uid: 'alice' }));
}

export async function assertM68WriteValidationMatrix(): Promise<void> {
  const invalidValues: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    { '.sv': 'bogus' },
    { '.sv': { increment: 'not-a-number' } },
  ];
  const invalidKeys = ['bad.key', 'bad#key', 'bad$key', 'bad/key', 'bad[key', 'bad]key', 'bad\u0000key'];
  const operations = (value: unknown) => {
    const db = setup();
    const target = api.ref(db, 'target');
    const synchronous: Array<() => unknown> = [
      () => api.set(target, value),
      () => api.update(target, { child: value }),
    ];
    if (value !== undefined) {
      synchronous.push(() => api.push(target, value));
      synchronous.push(() => api.runTransaction(target, () => value));
    }
    return synchronous;
  };
  for (const value of invalidValues) {
    for (const operation of operations(value)) expect(operation).toThrow(Error);
  }
  for (const key of invalidKeys) {
    for (const operation of operations({ [key]: 1 })) expect(operation).toThrow(Error);
  }
}

export async function assertM76ValidateAtomicity(): Promise<void> {
  for (const operation of ['set', 'update', 'transaction'] as const) {
    const db = setup();
    api.sandbox.setRules(db, { rules: { '.read': true, '.write': true, item: { '.validate': "newData.hasChildren(['required'])" } } });
    await api.set(api.ref(db, 'stable'), { untouched: true });
    const before = (await api.get(api.ref(db))).val();
    if (operation === 'set') {
      await expect(api.set(api.ref(db, 'item'), { optional: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } else if (operation === 'update') {
      await expect(api.update(api.ref(db), { 'item/optional': true, 'other/wouldCommit': true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } else {
      await expect(api.runTransaction(api.ref(db, 'item'), () => ({ optional: true }))).rejects.toThrow('permission_denied');
    }
    expect((await api.get(api.ref(db))).val()).toEqual(before);
  }
}
