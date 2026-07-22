/** RTDB reads, writes, priorities, and push operations over the worker port. */
import { dataRpc, nextId } from "./core.js";
import type { RtdbDataSnapshot, RtdbRefHandle } from "./handles.js";
import { makeRtdbRef, targetParts, type RtdbTarget } from "./rtdb-references.js";
import { hydrateRtdbSnapshot } from "./rtdb-snapshots.js";

const RTDB_PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

let lastRtdbPushTime = 0;

const lastRtdbRandChars: number[] = new Array(12).fill(0);

function generateRtdbPushId(now: number = Date.now()): string {
  const duplicateTime = now === lastRtdbPushTime;
  lastRtdbPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = RTDB_PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) throw new Error('RTDB push-id: timestamp overflow.');

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

  let id = timeStampChars.join('');
  for (let i = 0; i < 12; i++) id += RTDB_PUSH_CHARS.charAt(lastRtdbRandChars[i]!);
  return id;
}

export async function rtdbGet(target: RtdbTarget): Promise<RtdbDataSnapshot> {
  const { ref: r, query } = targetParts(target);
  return hydrateRtdbSnapshot(
    r,
    await dataRpc(r.port, {
      t: 'op', id: nextId(), method: 'rtdb.get', path: r.path, ...(query ? { query } : {}),
    }),
  );
}

export async function rtdbSet(r: RtdbRefHandle, value: unknown): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.set', path: r.path, value });
}

export async function rtdbSetPriority(
  r: RtdbRefHandle,
  priority: string | number | null,
): Promise<void> {
  await dataRpc(r.port, {
    t: 'op', id: nextId(), method: 'rtdb.setPriority', path: r.path, priority,
  });
}

export async function rtdbSetWithPriority(
  r: RtdbRefHandle,
  value: unknown,
  priority: string | number | null,
): Promise<void> {
  await dataRpc(r.port, {
    t: 'op', id: nextId(), method: 'rtdb.setWithPriority', path: r.path, value, priority,
  });
}

export async function rtdbUpdate(r: RtdbRefHandle, values: Record<string, unknown>): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.update', path: r.path, values });
}

export async function rtdbRemove(r: RtdbRefHandle): Promise<void> {
  await dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.remove', path: r.path });
}

export function rtdbPush(r: RtdbRefHandle, value?: unknown): RtdbRefHandle & PromiseLike<RtdbRefHandle> {
  const key = generateRtdbPushId();
  const pushed = makeRtdbRef(r.port, `${r.path}/${key}`);
  const settledRef = makeRtdbRef(r.port, pushed.path);
  const promise = dataRpc(r.port, { t: 'op', id: nextId(), method: 'rtdb.push', path: r.path, key, value })
    .then(() => settledRef);
  return Object.assign(pushed, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  });
}
