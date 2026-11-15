import { normalizeNode } from './sandbox/normalize.js';

export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === '/') return descendant !== '/';
  const prefix = `${ancestor.replace(/\/+$/, '')}/`;
  return descendant !== ancestor && descendant.startsWith(prefix);
}

export function isSameOrDescendantPath(ancestor: string, candidate: string): boolean {
  return ancestor === '/' || candidate === ancestor || isAncestorPath(ancestor, candidate);
}

export function joinPath(basePath: string, segments: readonly string[]): string {
  const trimmed = basePath.replace(/\/+$/, '');
  const suffix = segments.join('/');
  if (trimmed === '') return `/${suffix}`;
  return `${trimmed}/${suffix}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalarPriority(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function isSentinelLeaf(value: object): boolean {
  return Object.hasOwn(value, '.sv') || Object.hasOwn(value, '__rtdbSentinel');
}

function unwrapDotValue(value: unknown): unknown {
  if (isPlainRecord(value) && Object.hasOwn(value, '.value')) {
    return value['.value'];
  }
  return value;
}

/**
 * A value with children a cancellation can reach. A server value
 * (`{ ".sv": ... }`) or primitive `.value` wrapper is a leaf, as the SDK holds
 * it, so a path below it names nothing and cancelling that path leaves it whole.
 */
export function hasChildren(value: unknown): value is object {
  const unwrapped = unwrapDotValue(value);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  return !isSentinelLeaf(unwrapped);
}

export function hasDataContent(value: unknown): boolean {
  const unwrapped = unwrapDotValue(value);
  if (unwrapped === null || unwrapped === undefined) return false;
  if (typeof unwrapped !== 'object') return true;
  if (isSentinelLeaf(unwrapped)) return true;
  return normalizeNode(unwrapped) !== null;
}

function childRecord(value: unknown): Record<string, unknown> | null {
  if (!hasChildren(value)) return null;
  const unwrapped = unwrapDotValue(value);
  if (Array.isArray(unwrapped)) {
    const entries: Array<[string, unknown]> = [];
    for (let index = 0; index < unwrapped.length; index += 1) {
      const entry = unwrapped[index];
      if (entry != null) entries.push([String(index), entry]);
    }
    return Object.fromEntries(entries);
  }
  if (!isPlainRecord(unwrapped)) return null;
  return unwrapped;
}

function isPrefixSegments(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.every((segment, index) => segment === full[index]);
}

export function hasNestedPath(
  value: unknown,
  segments: readonly string[],
  includeNullEntries = false,
): boolean {
  if (segments.length === 0) return false;
  const record = childRecord(value);
  if (record === null) return false;
  for (const [key, entryValue] of Object.entries(record)) {
    if (key.startsWith('.') || entryValue === undefined) continue;
    if (entryValue === null && !includeNullEntries) continue;
    const keySegs = pathSegments(key);
    if (keySegs.length === 0) continue;
    if (keySegs.length >= segments.length) {
      if (isPrefixSegments(segments, keySegs)) return true;
      continue;
    }
    if (entryValue === null) continue;
    const reachesDescendant =
      isPrefixSegments(keySegs, segments) &&
      hasNestedPath(entryValue, segments.slice(keySegs.length));
    if (reachesDescendant) return true;
  }
  return false;
}

export function effectiveSetPriority(
  value: object,
  priority: string | number | null | undefined,
): unknown {
  if (isPlainRecord(value) && Object.hasOwn(value, '.priority')) {
    return value['.priority'];
  }
  return priority;
}

function ownNodePriority(value: unknown): { present: boolean; priority: unknown } {
  if (!isPlainRecord(value) || !Object.hasOwn(value, '.priority')) {
    return { present: false, priority: null };
  }
  const raw = value['.priority'];
  if (raw === undefined) {
    return { present: false, priority: null };
  }
  return { present: true, priority: structuredClone(raw) };
}

function isPriorityEntryKey(entryKey: string): boolean {
  const segs = pathSegments(entryKey);
  return segs.length > 0 && segs[segs.length - 1] === '.priority';
}

export function hasDataUnderPrefix(
  entries: ReadonlyArray<readonly [string, unknown]>,
  ownerPrefix: string,
): boolean {
  const ownerSegs = pathSegments(ownerPrefix);
  for (const [entryKey, entryValue] of entries) {
    if (isPriorityEntryKey(entryKey)) continue;
    if (!hasDataContent(entryValue)) continue;
    if (ownerSegs.length === 0) return true;
    const entrySegs = pathSegments(entryKey);
    if (entrySegs.length >= ownerSegs.length && isPrefixSegments(ownerSegs, entrySegs)) {
      return true;
    }
  }
  return false;
}

export function pruneOrphanedPriorities(
  entries: Array<[string, unknown]>,
  owners: ReadonlySet<string>,
): Array<[string, unknown]> {
  if (owners.size === 0) return entries;
  return entries.filter(([entryKey]) => {
    if (!isPriorityEntryKey(entryKey)) return true;
    const ownerPrefix = pathSegments(entryKey).slice(0, -1).join('/');
    if (!owners.has(ownerPrefix)) return true;
    return hasDataUnderPrefix(entries, ownerPrefix);
  });
}

export function unfoldWithoutNestedPath(
  prefix: string,
  value: unknown,
  segments: readonly string[],
  unfoldedPriorityOwners: Set<string>,
  includeRootOwnPriority: boolean,
  includeNullEntries = false,
): Array<[string, unknown]> {
  if (segments.length === 0) return [];
  const record = childRecord(value);
  if (record === null) return [[prefix, structuredClone(value)]];
  const entries = Object.entries(record).flatMap(([childKey, childValue]): Array<[string, unknown]> => {
    if (childKey.startsWith('.') || childValue === undefined) return [];
    if (childValue === null && !includeNullEntries) return [];
    const keySegs = pathSegments(childKey);
    if (keySegs.length === 0) return [];
    const joinedKey = keySegs.join('/');
    let childPrefix = joinedKey;
    if (prefix !== '') {
      childPrefix = `${prefix}/${joinedKey}`;
    }
    if (keySegs.length >= segments.length) {
      if (isPrefixSegments(segments, keySegs)) return [];
      return [[childPrefix, structuredClone(childValue)]];
    }
    if (!isPrefixSegments(keySegs, segments) || childValue === null) {
      return [[childPrefix, structuredClone(childValue)]];
    }
    return unfoldWithoutNestedPath(
      childPrefix,
      childValue,
      segments.slice(keySegs.length),
      unfoldedPriorityOwners,
      false,
    );
  });
  const ownPriority = ownNodePriority(value);
  if (ownPriority.present) {
    if (prefix !== '') {
      unfoldedPriorityOwners.add(prefix);
      if (hasDataUnderPrefix(entries, prefix)) {
        entries.push([`${prefix}/.priority`, ownPriority.priority]);
      }
    } else if (includeRootOwnPriority) {
      const cancelsRootPriority = segments.length === 1 && segments[0] === '.priority';
      if (!cancelsRootPriority) {
        entries.push(['.priority', ownPriority.priority]);
      }
    }
  }
  return entries;
}

export function applyInlinePriority(value: unknown, priority: unknown): unknown {
  if (!hasDataContent(value)) return null;
  if (priority === null || priority === undefined) {
    if (!isPlainRecord(value) || !Object.hasOwn(value, '.priority')) {
      return structuredClone(value);
    }
    const copy = structuredClone(value);
    delete copy['.priority'];
    if (Object.hasOwn(copy, '.value') && Object.keys(copy).length === 1) {
      return copy['.value'];
    }
    return copy;
  }
  const clonedPriority = structuredClone(priority);
  const record = childRecord(value);
  if (record !== null) {
    const next = structuredClone(record);
    next['.priority'] = clonedPriority;
    return next;
  }
  return { '.value': structuredClone(unwrapDotValue(value)), '.priority': clonedPriority };
}

function buildNestedValue(segments: readonly string[], leafValue: unknown): unknown {
  if (segments.length === 0) {
    if (!hasDataContent(leafValue)) return null;
    return structuredClone(leafValue);
  }
  if (!hasDataContent(leafValue)) return null;
  const [head, ...rest] = segments;
  if (head === undefined || head === '.priority') return null;
  const child = buildNestedValue(rest, leafValue);
  if (!hasDataContent(child)) return null;
  return { [head]: child };
}

function overlayNodeValue(current: unknown, segments: readonly string[], replacement: unknown): unknown {
  if (segments.length === 0) {
    if (!hasDataContent(replacement)) return null;
    return structuredClone(replacement);
  }
  const [head, ...rest] = segments;
  if (head === undefined) return structuredClone(current);
  if (head === '.priority') {
    return applyInlinePriority(current, replacement);
  }
  const replacementHasData = hasDataContent(replacement);
  if (!hasDataContent(current)) {
    if (!replacementHasData) return null;
    return buildNestedValue(segments, replacement);
  }
  const record = childRecord(current);
  if (record === null) {
    if (!replacementHasData) return structuredClone(current);
    const created = buildNestedValue(segments, replacement);
    if (!hasDataContent(created)) return structuredClone(current);
    const ownPriority = ownNodePriority(current);
    if (ownPriority.present) {
      return applyInlinePriority(created, ownPriority.priority);
    }
    return created;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (key.startsWith('.') || !hasDataContent(entryValue)) continue;
    next[key] = structuredClone(entryValue);
  }
  let existingChild: unknown = null;
  if (Object.hasOwn(next, head)) {
    existingChild = next[head];
  }
  const updatedChild = overlayNodeValue(existingChild, rest, replacement);
  if (hasDataContent(updatedChild)) {
    next[head] = updatedChild;
  } else {
    delete next[head];
  }
  if (Object.keys(next).length === 0) return null;
  const ownPriority = ownNodePriority(current);
  if (ownPriority.present) {
    next['.priority'] = ownPriority.priority;
  }
  return next;
}

interface ParsedUpdateEntry {
  readonly segments: string[];
  readonly key: string;
  readonly value: unknown;
}

/**
 * Orders an atomic update patch so additions run before deletions and `.priority`
 * updates run last, preventing transient empty-node pruning from dropping inline
 * priorities based on JavaScript key order.
 */
function orderUpdateEntries(values: Record<string, unknown>): ParsedUpdateEntry[] {
  const additions: ParsedUpdateEntry[] = [];
  const deletions: ParsedUpdateEntry[] = [];
  const priorities: ParsedUpdateEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const segments = pathSegments(rawKey);
    if (segments.length === 0) continue;
    const key = segments.join('/');
    const parsed: ParsedUpdateEntry = { segments, key, value: rawValue };
    if (isPriorityEntryKey(key)) {
      priorities.push(parsed);
    } else if (hasDataContent(rawValue)) {
      additions.push(parsed);
    } else {
      deletions.push(parsed);
    }
  }
  return [...additions, ...deletions, ...priorities];
}

export function overlaySetValues(
  baseValue: unknown,
  basePriority: string | number | null | undefined,
  values: Record<string, unknown>,
): { value: unknown; priority: string | number | null | undefined } {
  const inlineRoot = ownNodePriority(baseValue);
  let nextValue = structuredClone(baseValue);
  let nextPriority: string | number | null | undefined = undefined;
  let hasInlineRootPriority = false;
  let inlineRootPriority: unknown = undefined;
  if (hasDataContent(nextValue)) {
    if (inlineRoot.present) {
      hasInlineRootPriority = true;
      inlineRootPriority = inlineRoot.priority;
      nextValue = applyInlinePriority(nextValue, null);
    } else {
      nextPriority = basePriority;
    }
  }
  let hasRootPriorityUpdate = false;
  let rootPriorityValue: unknown = null;
  for (const entry of orderUpdateEntries(values)) {
    if (entry.segments.length === 1 && entry.segments[0] === '.priority') {
      hasRootPriorityUpdate = true;
      rootPriorityValue = entry.value;
      continue;
    }
    nextValue = overlayNodeValue(nextValue, entry.segments, entry.value);
  }
  if (!hasDataContent(nextValue)) {
    return { value: null, priority: undefined };
  }
  if (hasRootPriorityUpdate) {
    if (rootPriorityValue === null || rootPriorityValue === undefined) {
      return { value: applyInlinePriority(nextValue, null), priority: undefined };
    }
    if (isScalarPriority(rootPriorityValue)) {
      return { value: applyInlinePriority(nextValue, null), priority: rootPriorityValue };
    }
    return { value: applyInlinePriority(nextValue, rootPriorityValue), priority: undefined };
  }
  if (hasInlineRootPriority) {
    return { value: applyInlinePriority(nextValue, inlineRootPriority), priority: undefined };
  }
  return { value: nextValue, priority: nextPriority };
}

export function mergeUpdateValues(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  priorityOwners?: Set<string>,
): Record<string, unknown> {
  const merged = new Map<string, { segments: string[]; value: unknown }>();
  for (const [rawKey, rawValue] of Object.entries(existing)) {
    const segments = pathSegments(rawKey);
    if (segments.length === 0) continue;
    merged.set(segments.join('/'), { segments, value: structuredClone(rawValue) });
  }
  for (const entry of orderUpdateEntries(incoming)) {
    const { segments: inSegs, key: inKey, value: rawValue } = entry;
    if (merged.has(inKey)) {
      if (priorityOwners !== undefined && isPriorityEntryKey(inKey)) {
        priorityOwners.delete(inSegs.slice(0, -1).join('/'));
      }
      merged.set(inKey, { segments: inSegs, value: structuredClone(rawValue) });
      continue;
    }
    let overlaidAncestor = false;
    for (const [existingKey, existingEntry] of merged.entries()) {
      const isExistingAncestor =
        existingEntry.segments.length < inSegs.length &&
        isPrefixSegments(existingEntry.segments, inSegs);
      if (!isExistingAncestor) continue;
      const relative = inSegs.slice(existingEntry.segments.length);
      const overlaid = overlayNodeValue(existingEntry.value, relative, rawValue);
      merged.set(existingKey, { segments: existingEntry.segments, value: overlaid });
      overlaidAncestor = true;
      break;
    }
    if (overlaidAncestor) continue;
    for (const [existingKey, existingEntry] of [...merged.entries()]) {
      const isExistingDescendant =
        inSegs.length < existingEntry.segments.length &&
        isPrefixSegments(inSegs, existingEntry.segments);
      if (isExistingDescendant) {
        merged.delete(existingKey);
      }
    }
    if (priorityOwners !== undefined) {
      for (const owner of [...priorityOwners]) {
        const ownerSegs = pathSegments(owner);
        if (ownerSegs.length >= inSegs.length && isPrefixSegments(inSegs, ownerSegs)) {
          priorityOwners.delete(owner);
        }
      }
    }
    merged.set(inKey, { segments: inSegs, value: structuredClone(rawValue) });
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of merged.entries()) {
    result[key] = entry.value;
  }
  return result;
}
