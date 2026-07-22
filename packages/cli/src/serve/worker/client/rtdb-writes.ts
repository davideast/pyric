/** RTDB writes, priorities, and push-ID generation over the worker port. */
import { dataRpc, nextId } from './core.js';
import type { RtdbRefHandle } from './handles.js';
import { makeRtdbRef } from './rtdb-references.js';

const RTDB_PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastRtdbPushTime = 0;
const lastRtdbRandChars: number[] = new Array(12).fill(0);

function generateRtdbPushId(now: number = Date.now()): string {
  const duplicateTime = now === lastRtdbPushTime;
  lastRtdbPushTime = now;
  const timestampChars: string[] = new Array(8);
  let timestamp = now;
  for (let i = 7; i >= 0; i--) {
    timestampChars[i] = RTDB_PUSH_CHARS.charAt(timestamp % 64);
    timestamp = Math.floor(timestamp / 64);
  }
  if (timestamp !== 0) throw new Error('RTDB push-id: timestamp overflow.');
  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) lastRtdbRandChars[i] = Math.floor(Math.random() * 64);
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRtdbRandChars[i] === 63; i--) lastRtdbRandChars[i] = 0;
    if (i < 0) {
      for (let j = 0; j < 12; j++) lastRtdbRandChars[j] = Math.floor(Math.random() * 64);
    } else {
      lastRtdbRandChars[i] = (lastRtdbRandChars[i] ?? 0) + 1;
    }
  }
  return timestampChars.join('') + lastRtdbRandChars.map((n) => RTDB_PUSH_CHARS.charAt(n)).join('');
}

export async function rtdbSet(ref: RtdbRefHandle, value: unknown): Promise<void> {
  await dataRpc(ref.port, { t: 'op', id: nextId(), method: 'rtdb.set', path: ref.path, value });
}

export async function rtdbSetPriority(ref: RtdbRefHandle, priority: string | number | null): Promise<void> {
  await dataRpc(ref.port, { t: 'op', id: nextId(), method: 'rtdb.setPriority', path: ref.path, priority });
}

export async function rtdbSetWithPriority(
  ref: RtdbRefHandle,
  value: unknown,
  priority: string | number | null,
): Promise<void> {
  await dataRpc(ref.port, {
    t: 'op', id: nextId(), method: 'rtdb.setWithPriority', path: ref.path, value, priority,
  });
}

export async function rtdbUpdate(ref: RtdbRefHandle, values: Record<string, unknown>): Promise<void> {
  await dataRpc(ref.port, { t: 'op', id: nextId(), method: 'rtdb.update', path: ref.path, values });
}

export async function rtdbRemove(ref: RtdbRefHandle): Promise<void> {
  await dataRpc(ref.port, { t: 'op', id: nextId(), method: 'rtdb.remove', path: ref.path });
}

export function rtdbPush(
  ref: RtdbRefHandle,
  value?: unknown,
): RtdbRefHandle & PromiseLike<RtdbRefHandle> {
  const key = generateRtdbPushId();
  const pushed = makeRtdbRef(ref.port, `${ref.path}/${key}`);
  const settledRef = makeRtdbRef(ref.port, pushed.path);
  const promise = dataRpc(ref.port, {
    t: 'op', id: nextId(), method: 'rtdb.push', path: ref.path, key, value,
  }).then(() => settledRef);
  return Object.assign(pushed, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  });
}
