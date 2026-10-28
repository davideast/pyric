/**
 * RP-1 and RP-6 (#1362): the served RTDB client refuses a write the SDK
 * refuses, synchronously and with the SDK's text, before any frame leaves.
 * On the Node host the frame is JSON, where NaN and Infinity become null and
 * an undefined member vanishes, so a write the client let through deleted
 * data. Each expected text below is what firebase 12.13.0 throws offline.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { encodeBridgeMessage } from '../../../src/bridge/frame-output.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { connectClientToHost, makeHostCtx } from './integration-support.js';

let previousWorker: unknown;
beforeEach(() => { previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker; });

type Rtdb = ReturnType<typeof client.rtdbGetDatabase>;
type Ref = ReturnType<typeof client.rtdbRef>;

const PRIORITY_RULE = 'must be a valid Firebase priority (a string, finite number, server value, or null).';
const NOT_AN_OBJECT = 'values argument  must be an object containing the children to replace.';

interface InvalidWrite {
  name: string;
  seed: unknown;
  write: (ref: Ref) => unknown;
  message: string;
}

const INVALID_WRITES: InvalidWrite[] = [
  { name: 'set NaN', seed: 5, write: (ref) => client.rtdbSet(ref, NaN), message: "set failed: value argument contains NaN in property 'a'" },
  { name: 'set Infinity', seed: 5, write: (ref) => client.rtdbSet(ref, Infinity), message: "set failed: value argument contains Infinity in property 'b'" },
  {
    name: 'set an undefined member', seed: { k: 5 }, write: (ref) => client.rtdbSet(ref, { k: undefined, j: 1 }),
    message: "set failed: value argument contains undefined in property 'c.k'",
  },
  {
    name: 'update a NaN child', seed: { k: 5, j: 1 }, write: (ref) => client.rtdbUpdate(ref, { k: NaN }),
    message: "update failed: values argument contains NaN in property 'd.k'",
  },
  {
    name: 'update an undefined child', seed: { k: 5, j: 1 }, write: (ref) => client.rtdbUpdate(ref, { k: undefined }),
    message: "update failed: values argument contains undefined in property 'e.k'",
  },
  {
    name: 'setPriority NaN', seed: { '.value': 5, '.priority': 3 }, write: (ref) => client.rtdbSetPriority(ref, NaN),
    message: `setPriority failed: priority argument is NaN, but ${PRIORITY_RULE}`,
  },
  { name: 'push NaN', seed: null, write: (ref) => client.rtdbPush(ref, NaN), message: "push failed: value argument contains NaN in property 'g'" },
  {
    name: 'onDisconnect set NaN', seed: 5, write: (ref) => client.rtdbOnDisconnect(ref).set(NaN),
    message: "OnDisconnect.set failed: value argument contains NaN in property 'h'",
  },
  {
    name: 'setWithPriority with a NaN priority', seed: null, write: (ref) => client.rtdbSetWithPriority(ref, 1, NaN),
    message: `setWithPriority failed: priority argument is NaN, but ${PRIORITY_RULE}`,
  },
  {
    name: 'onDisconnect update a NaN child', seed: 5, write: (ref) => client.rtdbOnDisconnect(ref).update({ k: NaN }),
    message: "OnDisconnect.update failed: values argument contains NaN in property 'j.k'",
  },
];

async function servedDatabase(): Promise<Rtdb> {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
  const { db } = connectClientToHost(ctx, `worker://rtdb-invalid-writes-${Math.random()}`);
  return client.rtdbGetDatabase(db);
}

async function seed(ref: Ref, value: unknown): Promise<void> {
  const hasNoSeed = value === null;
  if (hasNoSeed) return;
  await client.rtdbSet(ref, value);
}

async function stored(ref: Ref): Promise<unknown> {
  return (await client.rtdbGet(ref)).exportVal();
}

/** The message a call throws synchronously, or what it did instead. */
function thrownMessage(call: () => unknown): string {
  try {
    const returned = call() as { catch?: (fn: () => void) => void } | undefined;
    returned?.catch?.(() => {});
    return 'returned without throwing';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('served RTDB writes with values the SDK refuses', () => {
  it('throw synchronously with the SDK text and leave stored data unchanged', async () => {
    const rtdb = await servedDatabase();
    let letter = 'a'.charCodeAt(0);
    for (const write of INVALID_WRITES) {
      const ref = client.rtdbRef(rtdb, String.fromCharCode(letter++));
      await seed(ref, write.seed);
      const before = await stored(ref);
      expect(thrownMessage(() => write.write(ref)), write.name).toBe(write.message);
      expect(await stored(ref), write.name).toEqual(before);
    }
  });

  it('update with an array or a string throws that values must be an object', async () => {
    const rtdb = await servedDatabase();
    const ref = client.rtdbRef(rtdb, 'u');
    const values = (value: unknown) => value as Record<string, unknown>;
    expect(thrownMessage(() => client.rtdbUpdate(ref, values([1])))).toBe(`update failed: ${NOT_AN_OBJECT}`);
    expect(thrownMessage(() => client.rtdbUpdate(ref, values('x')))).toBe(`update failed: ${NOT_AN_OBJECT}`);
    expect(thrownMessage(() => client.rtdbOnDisconnect(ref).update(values([1])))).toBe(`OnDisconnect.update failed: ${NOT_AN_OBJECT}`);
  });

  it('accept the values the SDK accepts', async () => {
    const rtdb = await servedDatabase();
    const ref = client.rtdbRef(rtdb, 'ok');
    await client.rtdbSet(ref, { n: 1, s: 'x', b: true, list: [1, 2], gone: null, t: { '.sv': 'timestamp' } });
    await client.rtdbSetWithPriority(client.rtdbRef(rtdb, 'ok/p'), 1, 3);
    await client.rtdbUpdate(ref, { n: 2, 'deep/path': 'y' });
    const after = await stored(ref) as Record<string, unknown>;
    expect(after.n).toBe(2);
    expect(after.deep).toEqual({ path: 'y' });
    expect(after.p).toEqual({ '.value': 1, '.priority': 3 });
  });
});

describe('the JSON frame encoder', () => {
  const op = (message: Record<string, unknown>) => ({ type: 'worker-message', message: { t: 'op', id: 'm1', path: '/a', ...message } }) as never;

  it('refuses an RTDB value JSON cannot carry rather than send it as a delete', () => {
    expect(() => encodeBridgeMessage(op({ method: 'rtdb.set', value: NaN }))).toThrow('value at /a holds NaN');
    expect(() => encodeBridgeMessage(op({ method: 'rtdb.update', values: { k: { j: Infinity } } }))).toThrow('values at /a/k/j holds Infinity');
    expect(() => encodeBridgeMessage(op({ method: 'rtdb.onDisconnectSet', value: { k: undefined } }))).toThrow('value at /a/k holds undefined');
    expect(() => encodeBridgeMessage(op({ method: 'rtdb.setPriority', priority: NaN }))).toThrow('priority at /a holds NaN');
  });

  it('encodes a JSON-safe RTDB write unchanged', () => {
    const frame = op({ method: 'rtdb.set', value: { k: 1, list: [1, null] } });
    expect(JSON.parse(encodeBridgeMessage(frame)!)).toEqual(JSON.parse(JSON.stringify(frame)));
  });
});

describe('the host check on a served RTDB update', () => {
  function fakePort(): PortLike & { messages: OutboundMessage[] } {
    const messages: OutboundMessage[] = [];
    return { messages, postMessage: (m: OutboundMessage) => { messages.push(m); } };
  }

  async function op(ctx: HostCtx, msg: Record<string, unknown>): Promise<ResMessage> {
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'host-check', ...msg } as never);
    const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === 'host-check');
    if (!res) throw new Error(`no res for ${String(msg.method)}`);
    return res;
  }

  it('refuses values that are not an object with the SDK text', async () => {
    const ctx = await makeHostCtx();
    const update = await op(ctx, { method: 'rtdb.update', path: '/u', values: [1] });
    expect(update.ok === false && update.error.message).toBe(`update failed: ${NOT_AN_OBJECT}`);
    const onDisconnect = await op(ctx, { method: 'rtdb.onDisconnectUpdate', path: '/u', values: 'x' });
    expect(onDisconnect.ok === false && onDisconnect.error.message).toBe(`OnDisconnect.update failed: ${NOT_AN_OBJECT}`);
  });
});
