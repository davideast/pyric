/**
 * The RTDB trees the host keeps per instance, in Realtime Database's storage
 * model: a `null` or empty node does not exist, so writes prune emptied
 * ancestors and seeding merges trees key by key.
 */
import { normalizeRtdbPath } from '../worker/client/rtdb-references.js';
import { FORBIDDEN_KEYS, isPlainObject } from './json-values.js';

export function rtdbPathSegments(path: string): string[] {
  return path.split('/').filter((seg) => seg.length > 0);
}

export function canonicalRtdbPath(pathOrSegments: string | readonly string[]): string {
  if (typeof pathOrSegments === 'string') return normalizeRtdbPath(pathOrSegments);
  return normalizeRtdbPath(pathOrSegments.join('/'));
}

export function joinRtdbPath(base: string, relative: string): string {
  return canonicalRtdbPath([...rtdbPathSegments(base), ...rtdbPathSegments(relative)]);
}

export function toRtdbMockData(tree: unknown): Record<string, unknown> {
  if (tree === null || tree === undefined) return {};
  if (isPlainObject(tree)) return structuredClone(tree);
  return { '.value': structuredClone(tree) };
}

/**
 * Normalize an RTDB JSON subtree: strips `null` values and empty objects, matching
 * Firebase Realtime Database's storage model where empty nodes do not exist.
 */
function normalizeRtdbNode(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const obj: Record<string, unknown> = {};
    let hasAny = false;
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeRtdbNode(value[i]);
      if (normalized !== null) {
        obj[String(i)] = normalized;
        hasAny = true;
      }
    }
    if (!hasAny) return null;
    // Keep dense/normal arrays as arrays when every index 0..n-1 is present, else object.
    const allPresent = value.length > 0 && Object.keys(obj).length === value.length;
    if (!allPresent) return obj;
    return value.map((item) => normalizeRtdbNode(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const normalized = normalizeRtdbNode(v);
      if (normalized !== null) {
        out[k] = normalized;
        count += 1;
      }
    }
    return count === 0 ? null : out;
  }
  return null;
}

export function setRtdbAtSegments(current: unknown, segments: readonly string[], value: unknown): unknown {
  if (segments.length === 0) {
    return normalizeRtdbNode(value);
  }
  const [head, ...tail] = segments;
  if (!head || FORBIDDEN_KEYS.has(head)) return current;
  let base: Record<string, unknown>;
  if (Array.isArray(current)) {
    base = {};
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== null && current[i] !== undefined) {
        base[String(i)] = current[i];
      }
    }
  } else if (isPlainObject(current)) {
    base = { ...current };
  } else {
    base = {};
  }
  const nextChild = setRtdbAtSegments(base[head] ?? null, tail, value);
  if (nextChild === null) {
    delete base[head];
  } else {
    base[head] = nextChild;
  }
  return Object.keys(base).length === 0 ? null : base;
}

/**
 * Deep-merge an observed RTDB tree onto an existing sandbox RTDB tree for
 * `mode: 'merge'` seeding: plain objects merge key-by-key while primitives
 * and arrays overwrite at the observed leaf.
 */
export function mergeRtdbTrees(existing: unknown, incoming: unknown): unknown {
  const normalizedIncoming = normalizeRtdbNode(incoming);
  if (normalizedIncoming === null) return normalizeRtdbNode(existing);
  const normalizedExisting = normalizeRtdbNode(existing);
  if (isPlainObject(normalizedExisting) && isPlainObject(normalizedIncoming)) {
    const merged: Record<string, unknown> = { ...normalizedExisting };
    for (const [key, val] of Object.entries(normalizedIncoming)) {
      merged[key] = mergeRtdbTrees(merged[key], val);
    }
    return merged;
  }
  return structuredClone(normalizedIncoming);
}

