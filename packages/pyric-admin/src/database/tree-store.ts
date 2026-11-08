/**
 * In-memory RTDB tree operations, path validation, write argument validation,
 * completion callback wrappers, and monotonic 20-char push-id generation.
 */

import type { Sandbox } from 'pyric/sandbox';
import {
  errorPrefix,
  inlinePriorities,
  normalizeNode,
  validateUpdate,
  validateWrite,
} from 'pyric/database/internal';
import type { JsonValue } from './types.js';

/** One RTDB instance's in-memory tree and owning sandbox clock source. */
export interface SandboxState {
  root: Record<string, JsonValue>;
  sandbox: Sandbox;
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Normalise a path to non-empty segments. `'/'` -> `[]`.
 *  Throws if any segment is a prototype-pollution vector. */
export function pathSegments(path: string): string[] {
  if (path === '' || path === '/') return [];
  const segs = path.split('/').filter((s) => s.length > 0);
  for (const seg of segs) {
    if (UNSAFE_SEGMENTS.has(seg)) {
      throw new Error(
        `Invalid RTDB path segment '${seg}': the keys __proto__, prototype, ` +
          'and constructor are reserved and cannot appear in a path.',
      );
    }
  }
  return segs;
}

/** Join segments back into a `/`-prefixed canonical path. `[]` -> `'/'`. */
export function joinPath(segments: string[]): string {
  if (segments.length === 0) return '/';
  return '/' + segments.join('/');
}

/** Read the stored value at `path` in `root`: integer-keyed children stay
 *  object keys. `null` for absent paths. Returns a fresh copy. */
export function readPath(root: Record<string, JsonValue>, path: string): JsonValue {
  const segs = pathSegments(path);
  let node: JsonValue = root;
  for (const seg of segs) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return null;
    }
    const obj = node as { [key: string]: JsonValue };
    if (!Object.hasOwn(obj, seg)) return null;
    node = obj[seg]!;
  }
  return structuredClone(node);
}

/** Write a value `normalizeNode` built at `path`. `null` deletes and trims empty ancestors. */
export function writePath(
  root: Record<string, JsonValue>,
  path: string,
  value: JsonValue,
): void {
  const segs = pathSegments(path);
  if (segs.length === 0) {
    for (const k of Object.keys(root)) delete root[k];
    if (value === null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'pyric-admin/database sandbox: root write must be an object (or null to clear).',
      );
    }
    Object.assign(root, value);
    return;
  }
  let cursor: Record<string, JsonValue> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]!;
    const next = Object.hasOwn(cursor, k) ? cursor[k] : undefined;
    if (
      next === undefined ||
      next === null ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
      const fresh: Record<string, JsonValue> = {};
      cursor[k] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, JsonValue>;
    }
  }
  const lastKey = segs[segs.length - 1]!;
  if (value === null) {
    delete cursor[lastKey];
    trimEmptyAncestors(root, segs);
  } else {
    cursor[lastKey] = value;
  }
}

function trimEmptyAncestors(root: Record<string, JsonValue>, segs: string[]): void {
  for (let depth = segs.length - 1; depth >= 1; depth--) {
    const parentSegs = segs.slice(0, depth);
    const lastKey = segs[depth - 1]!;
    let parent: Record<string, JsonValue> = root;
    for (let i = 0; i < parentSegs.length - 1; i++) {
      const next = parent[parentSegs[i]!];
      if (
        next === undefined ||
        next === null ||
        typeof next !== 'object' ||
        Array.isArray(next)
      ) {
        return;
      }
      parent = next as Record<string, JsonValue>;
    }
    const child = parent[lastKey];
    if (
      child !== undefined &&
      child !== null &&
      typeof child === 'object' &&
      !Array.isArray(child)
    ) {
      const obj = child as Record<string, JsonValue>;
      if (Object.keys(obj).length === 0) {
        delete parent[lastKey];
        continue;
      }
    }
    return;
  }
}

/** Validate and normalize a `set` or `push` value synchronously. */
export function validateValueArg(fnName: 'set' | 'push', segs: string[], value: unknown): JsonValue {
  validateWrite(value, joinPath(segs), errorPrefix(fnName, 'value'));
  inlinePriorities(value);
  return normalizeNode(value);
}

function isPriorityKey(key: string): boolean {
  const segments = pathSegments(key);
  return segments[segments.length - 1] === '.priority';
}

/** Validate and normalize an `update` patch synchronously, dropping `.priority` keys. */
export function validateValuesArg(segs: string[], values: unknown): Record<string, JsonValue> {
  const entries = Object.entries(validateUpdate(values, joinPath(segs)));
  for (const [, value] of entries) inlinePriorities(value);
  const dataEntries = entries.filter(([key]) => !isPriorityKey(key));
  return Object.fromEntries(dataEntries.map(([key, value]) => [key, normalizeNode(value)]));
}

/** Run a synchronous in-memory write as a settled promise, invoking `onComplete` if supplied. */
export function settled(write: () => void, onComplete?: (err: Error | null) => void): Promise<void> {
  try {
    write();
  } catch (error) {
    if (onComplete) {
      try {
        onComplete(error as Error);
      } catch (cbError) {
        return Promise.reject(cbError);
      }
    }
    return Promise.reject(error);
  }
  if (onComplete) {
    try {
      onComplete(null);
    } catch (cbError) {
      return Promise.reject(cbError);
    }
  }
  return Promise.resolve();
}

/** Attach an optional `onComplete` callback to an asynchronous relayed write promise. */
export function withOnComplete(
  promise: Promise<void>,
  onComplete?: (err: Error | null) => void,
): Promise<void> {
  if (!onComplete) return promise;
  return promise.then(
    () => {
      onComplete(null);
    },
    (err: Error) => {
      onComplete(err);
      throw err;
    },
  );
}

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRandChars: number[] = new Array(12).fill(0);

/** Mint a 20-character monotonic RTDB push ID matching `@firebase/database`'s `nextPushId`. */
export function generatePushId(now: number = Date.now()): string {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) {
    throw new Error('RTDB push-id: timestamp overflow.');
  }
  let id = timeStampChars.join('');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) {
      lastRandChars[i] = Math.floor(Math.random() * 64);
    }
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) {
      lastRandChars[i] = 0;
    }
    if (i < 0) {
      for (let j = 0; j < 12; j++) {
        lastRandChars[j] = Math.floor(Math.random() * 64);
      }
    } else {
      lastRandChars[i] = (lastRandChars[i] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]!);
  }
  return id;
}
