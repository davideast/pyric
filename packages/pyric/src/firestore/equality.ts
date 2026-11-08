/** `pyric/firestore` — sandbox reference and snapshot equality helpers. */
import { converterOf, targetOf, underlyingOf } from './state.js';
import { taggedSnapshotsEqual } from './snapshots.js';
import type {
  DocumentReference,
  Query,
  DocumentSnapshot,
  QuerySnapshot,
} from './types.js';

function assertRecognizedPair(a: object, b: object): void {
  targetOf(a);
  targetOf(b);
}

export function refEqual(a: DocumentReference, b: DocumentReference): boolean {
  assertRecognizedPair(a, b);
  const targetA = targetOf(a as object);
  const targetB = targetOf(b as object);
  if ((targetA.sandbox ?? targetA) !== (targetB.sandbox ?? targetB)) return false;
  if ((targetA.app ?? null) !== (targetB.app ?? null)) return false;
  if ((converterOf(a as object) ?? null) !== (converterOf(b as object) ?? null)) return false;
  const underA = underlyingOf(a) as { path: string; doc?: unknown };
  const underB = underlyingOf(b) as { path: string; doc?: unknown };
  if ((typeof underA.doc === 'function') !== (typeof underB.doc === 'function')) return false;
  return underA.path === underB.path;
}

export function queryEqual(a: Query, b: Query): boolean {
  assertRecognizedPair(a as object, b as object);
  if (converterOf(a as object) !== converterOf(b as object)) return false;
  const left = underlyingOf(a as object) as {
    isStructurallyEqual?: (other: unknown) => boolean;
  };
  const right = underlyingOf(b as object);
  return left.isStructurallyEqual?.(right) ?? a === b;
}

export function snapshotEqual(
  a: DocumentSnapshot | QuerySnapshot,
  b: DocumentSnapshot | QuerySnapshot,
): boolean {
  assertRecognizedPair(a as object, b as object);
  return taggedSnapshotsEqual(a as object, b as object);
}
