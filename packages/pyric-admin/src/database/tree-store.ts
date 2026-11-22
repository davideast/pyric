/**
 * Path validation, write argument validation, completion callback wrappers,
 * and monotonic 20-char push-id generation.
 */

import {
  errorPrefix,
  inlinePriorities,
  normalizeNode,
  validatePriorityArg,
  validateUpdate,
  validateWrite,
  withPriorities,
  writePriority,
  type InlinePriority,
  type Priority,
} from 'pyric/database/internal';
import type { AdminServiceLifecycle } from '../app/lifecycle.js';
import type { JsonValue } from './types.js';

const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const INVALID_PATH_CHARS = /[.#$[\]\u0000-\u001F\u007F]/;

function assertValidPathString(fnName: string, path: unknown): asserts path is string {
  const isString = typeof path === 'string';
  const isEmpty = isString && path.length === 0;
  const hasForbiddenChar = isString && INVALID_PATH_CHARS.test(path);
  if (!isString || isEmpty || hasForbiddenChar) {
    throw new Error(
      `${fnName} failed: path argument was an invalid path = "${String(path)}". ` +
        'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"',
    );
  }
}

/**
 * Validate a root-anchored RTDB reference path (`Database#ref` or root
 * `Reference#child`), allowing a leading `/.info` segment while rejecting
 * empty strings, non-strings, control characters, and `.`, `#`, `$`, `[`, `]`.
 */
export function validateAdminRefPath(path: unknown): string {
  let candidate: unknown = path;
  if (typeof candidate === 'string' && candidate.length > 0) {
    candidate = candidate.replace(/^\/*\.info(\/|$)/, '/');
  }
  assertValidPathString('child', candidate);
  return path as string;
}

/**
 * Validate a relative `Reference#child(path)` argument, coercing numeric keys
 * to strings and permitting leading `.info` only when invoked on the root ref.
 */
export function validateAdminChildPath(parentSegs: readonly string[], path: unknown): string {
  let normalized: unknown = path;
  if (typeof normalized === 'number') {
    normalized = String(normalized);
  }
  if (parentSegs.length === 0) {
    return validateAdminRefPath(normalized);
  }
  assertValidPathString('child', normalized);
  return normalized;
}

/**
 * Validate a `DataSnapshot#child` or `DataSnapshot#hasChild` path argument.
 */
export function validateSnapshotChildPath(
  fnName: 'DataSnapshot.child' | 'DataSnapshot.hasChild',
  path: unknown,
  coerceToString: boolean,
): string {
  let candidate: unknown = path;
  if (coerceToString) {
    candidate = String(candidate);
  }
  assertValidPathString(fnName, candidate);
  return candidate;
}

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

function preserveNormalizedWithPriorities(value: unknown): JsonValue {
  const normalized = normalizeNode(value);
  if (normalized === null) {
    return null;
  }
  const extracted = writePriority(value, null);
  const entries: InlinePriority[] = [];
  if (extracted.inline) {
    entries.push({ segments: [], priority: extracted.priority });
  }
  for (const nestedEntry of extracted.nested) {
    entries.push(nestedEntry);
  }
  if (entries.length === 0) {
    return normalized;
  }
  return withPriorities(normalized, entries);
}

/** Validate and normalize a `set`, `push`, or `setWithPriority` value synchronously, preserving inline `.priority` metadata. */
export function validateValueArg(
  fnName: 'set' | 'push' | 'setWithPriority',
  segs: string[],
  value: unknown,
): JsonValue {
  validateWrite(value, joinPath(segs), errorPrefix(fnName, 'value'));
  inlinePriorities(value);
  return preserveNormalizedWithPriorities(value);
}

/** Validate a `setPriority` or `setWithPriority` priority argument synchronously. */
export function validateAdminPriorityArg(
  fnName: 'setPriority' | 'setWithPriority',
  priority: unknown,
): Priority {
  validatePriorityArg(fnName, priority);
  return priority as Priority;
}

/** Construct the server error thrown when `setPriority` targets a non-existent node with a non-null priority. */
export function absentNodeSetPriorityError(): Error {
  return Object.assign(
    new Error('INVALID_PARAMETERS: could not set priority on non-existent node'),
    { code: 'INVALID_PARAMETERS' },
  );
}

function isPriorityKey(key: string): boolean {
  const segments = pathSegments(key);
  return segments[segments.length - 1] === '.priority';
}

/** Validate and normalize an `update` patch synchronously, coercing arrays and preserving `.priority` entries. */
export function validateValuesArg(segs: string[], values: unknown): Record<string, JsonValue> {
  let candidateValues = values;
  if (Array.isArray(values)) {
    const coerced: Record<string, unknown> = {};
    for (let i = 0; i < values.length; i += 1) {
      if (i in values) {
        coerced[String(i)] = values[i];
      } else {
        coerced[String(i)] = null;
      }
    }
    candidateValues = coerced;
  }
  const entries = Object.entries(validateUpdate(candidateValues, joinPath(segs)));
  const normalizedEntries: Array<[string, JsonValue]> = [];
  for (const [key, value] of entries) {
    inlinePriorities(value);
    if (isPriorityKey(key)) {
      normalizedEntries.push([key, value as JsonValue]);
    } else {
      normalizedEntries.push([key, preserveNormalizedWithPriorities(value)]);
    }
  }
  return Object.fromEntries(normalizedEntries);
}

/** Run a synchronous in-memory write as a settled promise, invoking `onComplete` asynchronously if supplied. */
export function settled(write: () => void, onComplete?: (err: Error | null) => void): Promise<void> {
  try {
    write();
  } catch (error) {
    return withOnComplete(Promise.reject(error), onComplete);
  }
  return withOnComplete(Promise.resolve(), onComplete);
}

/** Return a rejected `app/app-deleted` promise when `lifecycle` has been tombstoned, or `null`. */
export function assertActivePromise(lifecycle?: AdminServiceLifecycle): Promise<void> | null {
  if (lifecycle?.isDeleted !== true) return null;
  try {
    lifecycle.assertActive();
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.reject(new Error('App has already been deleted.'));
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
