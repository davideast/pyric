/**
 * Firestore scalar ordering, structural equality (including array literals),
 * and single-clause satisfaction checks for domain witness synthesis.
 */
import {
  Bytes,
  Duration,
  LatLng,
  Path,
  queryProofScalarsEqual,
  Reference,
  RulesFloat,
  Timestamp,
  type QueryWhereConstraint,
} from '@pyric/rules/internal';

export type ScalarKind =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'timestamp'
  | 'duration'
  | 'bytes'
  | 'latlng'
  | 'reference'
  | 'path';

export function unwrapScalar(value: unknown): unknown {
  if (value instanceof RulesFloat) return value.value;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

export function scalarKindOf(raw: unknown): ScalarKind | null {
  const value = unwrapScalar(raw);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') return 'string';
  if (value instanceof Timestamp) return 'timestamp';
  if (value instanceof Duration) return 'duration';
  if (value instanceof Bytes) return 'bytes';
  if (value instanceof LatLng) return 'latlng';
  if (value instanceof Reference) return 'reference';
  if (value instanceof Path) return 'path';
  return null;
}

function compareStringsByCodePoint(a: string, b: string): number {
  const aPoints = [...a];
  const bPoints = [...b];
  const minLen = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < minLen; i += 1) {
    const ca = aPoints[i]!.codePointAt(0)!;
    const cb = bPoints[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return aPoints.length - bPoints.length;
}

function compareStringArrays(a: readonly string[], b: readonly string[]): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    const cmp = compareStringsByCodePoint(a[i]!, b[i]!);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

export function totalNanos(val: Timestamp | Duration): bigint {
  return BigInt(val.seconds) * 1_000_000_000n + BigInt(val.nanos);
}

export function fromTotalNanosTimestamp(ns: bigint): Timestamp {
  let seconds = ns / 1_000_000_000n;
  let nanos = ns % 1_000_000_000n;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += 1_000_000_000n;
  }
  return new Timestamp(Number(seconds), Number(nanos));
}

export function fromTotalNanosDuration(ns: bigint): Duration {
  let seconds = ns / 1_000_000_000n;
  let nanos = ns % 1_000_000_000n;
  if (nanos < 0n) {
    seconds -= 1n;
    nanos += 1_000_000_000n;
  }
  return new Duration(Number(seconds), Number(nanos));
}

export function compareOrderedScalars(rawA: unknown, rawB: unknown): number | null {
  const kindA = scalarKindOf(rawA);
  const kindB = scalarKindOf(rawB);
  if (kindA === null || kindB === null || kindA !== kindB || kindA === 'null') {
    return null;
  }
  const a = unwrapScalar(rawA);
  const b = unwrapScalar(rawB);
  switch (kindA) {
    case 'boolean':
      return Number(a as boolean) - Number(b as boolean);
    case 'number': {
      const numA = a as number;
      const numB = b as number;
      if (numA === numB) return 0;
      if (numA < numB) return -1;
      return 1;
    }
    case 'string':
      return compareStringsByCodePoint(a as string, b as string);
    case 'timestamp':
    case 'duration': {
      const nsA = totalNanos(a as Timestamp | Duration);
      const nsB = totalNanos(b as Timestamp | Duration);
      if (nsA === nsB) return 0;
      if (nsA < nsB) return -1;
      return 1;
    }
    case 'bytes': {
      const ba = (a as Bytes).data;
      const bb = (b as Bytes).data;
      const minLen = Math.min(ba.length, bb.length);
      for (let i = 0; i < minLen; i += 1) {
        if (ba[i]! !== bb[i]!) return ba[i]! - bb[i]!;
      }
      return ba.length - bb.length;
    }
    case 'latlng': {
      const la = a as LatLng;
      const lb = b as LatLng;
      if (la.lat !== lb.lat) return la.lat - lb.lat;
      return la.lng - lb.lng;
    }
    case 'reference': {
      const ra = a as Reference;
      const rb = b as Reference;
      const dbCmp = compareStringsByCodePoint(ra.databaseId, rb.databaseId);
      if (dbCmp !== 0) return dbCmp;
      return compareStringArrays(ra.path.split('/'), rb.path.split('/'));
    }
    case 'path':
      return compareStringArrays((a as Path).segments, (b as Path).segments);
  }
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!valuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (queryProofScalarsEqual(a, b)) return true;
  const cmp = compareOrderedScalars(a, b);
  return cmp === 0;
}

export function clauseMatchesCandidate(
  candidate: unknown,
  clause: QueryWhereConstraint,
): boolean {
  if (candidate === undefined) return false;
  switch (clause.op) {
    case '==':
      return valuesEqual(candidate, clause.value);
    case '!=':
      return candidate !== null && !valuesEqual(candidate, clause.value);
    case '<': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp < 0;
    }
    case '<=': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp <= 0;
    }
    case '>': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp > 0;
    }
    case '>=': {
      const cmp = compareOrderedScalars(candidate, clause.value);
      return cmp !== null && cmp >= 0;
    }
    case 'in':
      return (
        Array.isArray(clause.value)
        && clause.value.some((item) => valuesEqual(candidate, item))
      );
    case 'not-in':
      if (!Array.isArray(clause.value)) return false;
      if (clause.value.some((item) => item === null)) return false;
      return (
        candidate !== null
        && !clause.value.some((item) => valuesEqual(candidate, item))
      );
    case 'array-contains':
      return (
        Array.isArray(candidate)
        && candidate.some((item) => valuesEqual(item, clause.value))
      );
    case 'array-contains-any':
      return (
        Array.isArray(candidate)
        && Array.isArray(clause.value)
        && clause.value.some((target) =>
          candidate.some((item) => valuesEqual(item, target)),
        )
      );
    default:
      return false;
  }
}
