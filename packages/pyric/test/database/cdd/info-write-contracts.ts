import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as api from '../../../src/database/index.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

type Db = ReturnType<typeof api.getDatabase>;

/** Each write the rtdb-modular-info-write-validation capture runs, keyed by its behavior field. */
export const INFO_WRITES: Record<string, (db: Db) => unknown> = {
  set: (db) => api.set(api.ref(db, '.info/connected'), false),
  setNested: (db) => api.set(api.ref(db, '.info/custom/child'), 1),
  setWithPriority: (db) => api.setWithPriority(api.ref(db, '.info/connected'), false, 1),
  setPriority: (db) => api.setPriority(api.ref(db, '.info/connected'), 1),
  remove: (db) => api.remove(api.ref(db, '.info/connected')),
  push: (db) => api.push(api.ref(db, '.info'), 1),
  runTransaction: (db) => api.runTransaction(api.ref(db, '.info/connected'), () => false),
  updateOnInfo: (db) => api.update(api.ref(db, '.info'), { connected: false }),
  updateFromRoot: (db) => api.update(api.ref(db), { '.info/connected': false }),
  onDisconnectSet: (db) => api.onDisconnect(api.ref(db, '.info/connected')).set(false),
  onDisconnectSetWithPriority: (db) => api.onDisconnect(api.ref(db, '.info/connected')).setWithPriority(false, 1),
  onDisconnectUpdate: (db) => api.onDisconnect(api.ref(db, '.info')).update({ connected: false }),
  onDisconnectRemove: (db) => api.onDisconnect(api.ref(db, '.info/connected')).remove(),
};

/** Whether `task` throws, rejects or resolves, and with what, in the capture's shape. */
export async function captureInvocation(task: () => unknown): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = task();
  } catch (error) {
    return {
      timing: 'synchronous-throw',
      name: (error as Error).name,
      code: (error as { code?: unknown }).code ?? null,
      message: (error as Error).message,
    };
  }
  try {
    const resolved = await value;
    return { timing: 'resolved', value: resolved ?? null };
  } catch (error) {
    return {
      timing: 'asynchronous-reject',
      name: (error as Error).name,
      code: (error as { code?: unknown }).code ?? null,
      message: (error as Error).message,
    };
  }
}

export function infoWriteDb(): Db {
  const db = api.getDatabase(initializeSandbox().withAuth({ uid: 'alice' }));
  api.sandbox.setDefaultPolicy(db, 'allow');
  return db;
}

/** Every write under `/.info` fails as the capture records, and none changes data. */
export async function assertM95InfoWrites(): Promise<void> {
  const behavior = loadObservation('rtdb-modular-info-write-validation');
  expect(behavior.repeatCount).toBe(2);
  for (const [name, write] of Object.entries(INFO_WRITES)) {
    const db = infoWriteDb();
    const before = api.sandbox.snapshotState(db);
    expect(await captureInvocation(() => write(db))).toEqual(behavior[name]);
    expect(api.sandbox.snapshotState(db)).toEqual(before);
  }
}
