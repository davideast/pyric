import {
  CREATED_EVENT_TYPE,
  DELETED_EVENT_TYPE,
  UPDATED_EVENT_TYPE,
  WRITTEN_EVENT_TYPE,
  type RtdbValueEventType,
} from './discovery.js';
import {
  normalizeRtdbReference,
  rtdbReferenceParamName,
  rtdbReferenceParts,
} from './reference-pattern.js';

export interface RtdbSnapshotCommit {
  path: string;
  before: unknown;
  after: unknown;
}

type RtdbValueTransitionKind = 'created' | 'updated' | 'deleted';

export interface RtdbValueProjection {
  kind: RtdbValueTransitionKind;
  ref: string;
  params: Record<string, string>;
  before: unknown;
  after: unknown;
}

export interface CreatedValueProjection {
  ref: string;
  params: Record<string, string>;
  value: unknown;
}

function canonicalPath(path: string): string {
  const normalized = normalizeRtdbReference(path);
  return normalized ? `/${normalized}` : '/';
}

function pruneRtdbValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const entries: Array<[number, unknown]> = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) continue;
      const pruned = pruneRtdbValue(value[index]);
      if (pruned !== null) entries.push([index, pruned]);
    }
    if (entries.length === 0) return null;
    if (entries.every(([idx], pos) => idx === pos)) {
      return entries.map(([, item]) => item);
    }
    return Object.fromEntries(entries.map(([idx, item]) => [String(idx), item]));
  }
  if (typeof value === 'object') {
    const entries: Array<[string, unknown]> = [];
    for (const [key, childValue] of Object.entries(value)) {
      const pruned = pruneRtdbValue(childValue);
      if (pruned !== null) entries.push([key, pruned]);
    }
    if (entries.length > 0) return Object.fromEntries(entries);
    return null;
  }
  return value;
}

function rtdbNodeChildren(pruned: unknown): Map<string, unknown> | null {
  if (pruned === null || typeof pruned !== 'object') return null;
  const children = new Map<string, unknown>();
  if (Array.isArray(pruned)) {
    for (let index = 0; index < pruned.length; index += 1) {
      const item = pruned[index];
      if (item !== undefined && item !== null) {
        children.set(String(index), item);
      }
    }
    return children;
  }
  for (const [key, item] of Object.entries(pruned as Record<string, unknown>)) {
    if (item !== undefined && item !== null) {
      children.set(key, item);
    }
  }
  return children;
}

/** Compare two RTDB values after pruning nulls, empty subtrees, and array holes. */
export function rtdbValuesEqual(left: unknown, right: unknown): boolean {
  const prunedLeft = pruneRtdbValue(left);
  const prunedRight = pruneRtdbValue(right);
  if (Object.is(prunedLeft, prunedRight)) return true;
  if (prunedLeft === null || prunedRight === null) return false;
  const leftChildren = rtdbNodeChildren(prunedLeft);
  const rightChildren = rtdbNodeChildren(prunedRight);
  if (leftChildren === null || rightChildren === null) return false;
  if (leftChildren.size !== rightChildren.size) return false;
  for (const [key, leftChild] of leftChildren) {
    if (!rightChildren.has(key)) return false;
    if (!rtdbValuesEqual(leftChild, rightChildren.get(key))) return false;
  }
  return true;
}

function exists(value: unknown): boolean {
  return pruneRtdbValue(value) !== null;
}

function child(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function unionChildKeys(before: unknown, after: unknown): string[] {
  const keys = new Set<string>();
  if (typeof before === 'object' && before !== null) {
    for (const key of Object.keys(before)) {
      if (exists(child(before, key))) keys.add(key);
    }
  }
  if (typeof after === 'object' && after !== null) {
    for (const key of Object.keys(after)) {
      if (exists(child(after, key))) keys.add(key);
    }
  }
  return [...keys].sort();
}

export function watchPath(reference: string): string {
  const literal: string[] = [];
  for (const segment of rtdbReferenceParts(reference)) {
    if (rtdbReferenceParamName(segment)) break;
    literal.push(segment);
  }
  return canonicalPath(literal.join('/'));
}

function transitionMatchesEventType(
  kind: RtdbValueTransitionKind,
  eventType: RtdbValueEventType,
): boolean {
  if (eventType === WRITTEN_EVENT_TYPE) return true;
  if (kind === 'created') return eventType === CREATED_EVENT_TYPE;
  if (kind === 'updated') return eventType === UPDATED_EVENT_TYPE;
  return eventType === DELETED_EVENT_TYPE;
}

/** Project value transitions (`created`, `updated`, `deleted`, or `written`) for an RTDB reference. */
export function projectRtdbValueTransitions(
  eventType: RtdbValueEventType,
  reference: string,
  commit: RtdbSnapshotCommit,
): RtdbValueProjection[] {
  const pattern = rtdbReferenceParts(reference);
  const committed = rtdbReferenceParts(commit.path);
  if (committed.length > pattern.length) return [];

  const params: Record<string, string> = {};
  for (let index = 0; index < committed.length; index += 1) {
    const patternSegment = pattern[index];
    const committedSegment = committed[index];
    if (patternSegment === undefined || committedSegment === undefined) return [];
    const capture = rtdbReferenceParamName(patternSegment);
    if (capture) params[capture] = committedSegment;
    else if (patternSegment !== committedSegment) return [];
  }

  const projected: RtdbValueProjection[] = [];
  const visit = (
    depth: number,
    before: unknown,
    after: unknown,
    concrete: string[],
    captures: Record<string, string>,
  ): void => {
    if (depth === pattern.length) {
      const prunedBefore = pruneRtdbValue(before);
      const prunedAfter = pruneRtdbValue(after);
      const wasPresent = prunedBefore !== null;
      const isPresent = prunedAfter !== null;
      let kind: RtdbValueTransitionKind | null = null;
      if (!wasPresent && isPresent) {
        kind = 'created';
      } else if (wasPresent && !isPresent) {
        kind = 'deleted';
      } else if (wasPresent && isPresent && !rtdbValuesEqual(prunedBefore, prunedAfter)) {
        kind = 'updated';
      }
      if (kind !== null && transitionMatchesEventType(kind, eventType)) {
        projected.push({
          kind,
          ref: concrete.join('/'),
          params: captures,
          before: prunedBefore,
          after: prunedAfter,
        });
      }
      return;
    }

    const segment = pattern[depth];
    if (segment === undefined) return;
    const capture = rtdbReferenceParamName(segment);
    if (capture) {
      for (const key of unionChildKeys(before, after)) {
        visit(
          depth + 1,
          child(before, key),
          child(after, key),
          [...concrete, key],
          { ...captures, [capture]: key },
        );
      }
      return;
    }
    visit(
      depth + 1,
      child(before, segment),
      child(after, segment),
      [...concrete, segment],
      captures,
    );
  };

  visit(committed.length, commit.before, commit.after, committed, params);
  return projected;
}

/** Project absent-to-present values for one v2 RTDB create trigger reference. */
export function projectValueCreates(
  reference: string,
  commit: RtdbSnapshotCommit,
): CreatedValueProjection[] {
  return projectRtdbValueTransitions(CREATED_EVENT_TYPE, reference, commit).map(
    (item) => ({
      ref: item.ref,
      params: item.params,
      value: item.after,
    }),
  );
}
