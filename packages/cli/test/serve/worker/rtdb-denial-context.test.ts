/**
 * Served pages see the sandbox's RTDB `denialContext` on every denied
 * operation, the same frame an in-process sandbox error carries: one-shot
 * reads and writes, transactions (whose production error has no code), and
 * listener cancellations, both initial and after a rules change.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { serializeError } from '../../../src/serve/worker/protocol.js';
import type { HostCtx } from '../../../src/serve/worker/host.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.js';

const RULES = {
  rules: {
    rooms: {
      $roomId: {
        '.read': 'auth.uid == $roomId',
        '.write': 'auth.uid == $roomId',
      },
    },
    open: { '.read': 'true', '.write': 'auth.uid == "bob"' },
  },
};

let previousWorker: unknown;
let ctx: HostCtx;
let rtdb: ReturnType<typeof client.rtdbGetDatabase>;

beforeEach(async () => {
  previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  ctx = await makeHostCtx();
  rtdbSandbox.setRules(getDatabase(ctx.sandbox), RULES);
  const { db } = connectClientToHost(ctx, `worker://rtdb-denial-${Math.random()}`);
  rtdb = client.rtdbGetDatabase(db);
  client.setLens({ mode: 'as', uid: 'alice' });
});

afterEach(() => {
  client.setLens(undefined);
  (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker;
});

async function rejection(operation: () => Promise<unknown>): Promise<Error & { code?: string; denialContext?: unknown }> {
  try {
    await operation();
  } catch (error) {
    return error as Error & { code?: string; denialContext?: unknown };
  }
  throw new Error('expected the operation to reject');
}

const ROOM_RULE = {
  engine: 'rtdb',
  auth: { uid: 'alice' },
  matchedPath: '/rooms/$roomId',
  matchedRule: 'auth.uid == $roomId',
  pathVariableBindings: { $roomId: 'bob' },
};

test('get rejects with the RTDB denial context', async () => {
  const error = await rejection(() => client.rtdbGet(client.rtdbRef(rtdb, 'rooms/bob')));
  expect(error.code).toBe('PERMISSION_DENIED');
  expect(error.message).toBe('PERMISSION_DENIED: Permission denied');
  expect(error.denialContext).toMatchObject({ ...ROOM_RULE, request: { method: 'get', path: '/rooms/bob' } });
});

test('set rejects with the RTDB denial context and the proposed value', async () => {
  const error = await rejection(() => client.rtdbSet(client.rtdbRef(rtdb, 'rooms/bob/name'), 'Bob'));
  expect(error.code).toBe('PERMISSION_DENIED');
  expect(error.denialContext).toMatchObject({
    ...ROOM_RULE, request: { method: 'set', path: '/rooms/bob/name', data: 'Bob' },
  });
});

test('update rejects with the context of the denied path', async () => {
  const error = await rejection(() => client.rtdbUpdate(client.rtdbRef(rtdb, 'rooms'), { 'alice/n': 1, 'bob/n': 2 }));
  expect(error.code).toBe('PERMISSION_DENIED');
  expect(error.denialContext).toMatchObject({
    ...ROOM_RULE, request: { method: 'update', path: '/rooms/bob/n', data: 2 },
  });
});

test('a denied transaction keeps its message and carries the context', async () => {
  const error = await rejection(() => client.rtdbRunTransaction(client.rtdbRef(rtdb, 'open/count'), () => 1));
  expect(error.message).toBe('permission_denied');
  // Production's transaction rejection is a plain Error with no `code`.
  expect('code' in error).toBe(false);
  expect(error.denialContext).toMatchObject({
    engine: 'rtdb',
    request: { method: 'transaction', path: '/open/count', data: 1 },
    matchedRule: 'auth.uid == "bob"',
  });
});

test('a transaction on a location the rules deny reading runs its update function, as the sandbox does', async () => {
  const calls: unknown[] = [];
  const aborted = await client.rtdbRunTransaction(client.rtdbRef(rtdb, 'rooms/bob'), (current) => {
    calls.push(current);
    return undefined;
  });
  expect(calls).toEqual([null]);
  expect(aborted.committed).toBe(false);
  expect(aborted.snapshot.val()).toBeNull();
  // A write the rules deny rejects with the transaction's own error and writes nothing.
  rtdbSandbox.setData(getDatabase(ctx.sandbox), { '/rooms/bob': 5 });
  const error = await rejection(() => client.rtdbRunTransaction(client.rtdbRef(rtdb, 'rooms/bob'), () => 1));
  expect(error.message).toBe('permission_denied');
  expect(rtdbSandbox.snapshotState(getDatabase(ctx.sandbox))).toEqual({ rooms: { bob: 5 } });
});

test('an initially denied listener cancels with the context', async () => {
  const error = await new Promise<Error & { denialContext?: unknown }>((resolve) => {
    client.rtdbOnValue(client.rtdbRef(rtdb, 'rooms/bob'), () => {}, resolve);
  });
  expect((error as { code?: string }).code).toBe('PERMISSION_DENIED');
  expect(error.denialContext).toMatchObject({ ...ROOM_RULE, request: { method: 'listen', path: '/rooms/bob' } });
});

test('a listener revoked by a rules change cancels with the context', async () => {
  const errors: Array<Error & { denialContext?: unknown }> = [];
  client.rtdbOnValue(client.rtdbRef(rtdb, 'rooms/alice'), () => {}, (error) => errors.push(error));
  await sleep();
  rtdbSandbox.setRules(getDatabase(ctx.sandbox), { rules: { rooms: { '.read': 'false' } } });
  await sleep();
  expect(errors).toHaveLength(1);
  expect(errors[0]!.denialContext).toMatchObject({
    engine: 'rtdb', request: { method: 'listen', path: '/rooms/alice' },
  });
});

test('serializeError forwards a denial context on a codeless error', () => {
  const error = Object.assign(new Error('permission_denied'), {
    denialContext: { engine: 'rtdb', auth: null, reasons: [], request: { method: 'transaction', path: '/a' } },
  });
  expect(serializeError(error)).toEqual({
    code: 'unknown',
    codeless: true,
    message: 'permission_denied',
    denialContext: { engine: 'rtdb', auth: null, reasons: [], request: { method: 'transaction', path: '/a' } },
  });
});
