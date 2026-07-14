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

export interface CreatedValueProjection {
  ref: string;
  params: Record<string, string>;
  value: unknown;
}

function canonicalPath(path: string): string {
  const normalized = normalizeRtdbReference(path);
  return normalized ? `/${normalized}` : '/';
}

function exists(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function child(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function childKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.keys(value).filter((key) => exists(child(value, key))).sort();
}

export function watchPath(reference: string): string {
  const literal: string[] = [];
  for (const segment of rtdbReferenceParts(reference)) {
    if (rtdbReferenceParamName(segment)) break;
    literal.push(segment);
  }
  return canonicalPath(literal.join('/'));
}

/** Project absent-to-present values for one v2 RTDB trigger reference. */
export function projectValueCreates(
  reference: string,
  commit: RtdbSnapshotCommit,
): CreatedValueProjection[] {
  const pattern = rtdbReferenceParts(reference);
  const committed = rtdbReferenceParts(commit.path);
  if (committed.length > pattern.length) return [];

  const params: Record<string, string> = {};
  for (let index = 0; index < committed.length; index += 1) {
    const capture = rtdbReferenceParamName(pattern[index]);
    if (capture) params[capture] = committed[index];
    else if (pattern[index] !== committed[index]) return [];
  }

  const projected: CreatedValueProjection[] = [];
  const visit = (
    depth: number,
    before: unknown,
    after: unknown,
    concrete: string[],
    captures: Record<string, string>,
  ): void => {
    if (depth === pattern.length) {
      if (!exists(before) && exists(after)) {
        projected.push({ ref: concrete.join('/'), params: captures, value: after });
      }
      return;
    }
    const segment = pattern[depth];
    const capture = rtdbReferenceParamName(segment);
    if (capture) {
      for (const key of childKeys(after)) {
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
