/** `pyric/firestore` -- sandbox reference and snapshot equality helpers. */
import { converterOf, refToTarget, targetOf, underlyingOf } from './state.js';
import { taggedSnapshotsEqual } from './snapshots.js';
import {
  CollectionReference,
  DocumentReference,
  type Query,
  type DocumentSnapshot,
  type QuerySnapshot,
} from './types.js';

function assertRecognizedPair(a: object, b: object): [ReturnType<typeof targetOf>, ReturnType<typeof targetOf>] {
  return [targetOf(a), targetOf(b)];
}

function isReferenceHandle(candidate: unknown): candidate is object {
  return candidate instanceof DocumentReference || candidate instanceof CollectionReference;
}

function targetsShareOwner(
  targetA: ReturnType<typeof targetOf>,
  targetB: ReturnType<typeof targetOf>,
): boolean {
  if ((targetA.sandbox ?? targetA) !== (targetB.sandbox ?? targetB)) return false;
  if ((targetA.app ?? null) !== (targetB.app ?? null)) return false;
  if ((targetA.databaseId ?? '(default)') !== (targetB.databaseId ?? '(default)')) return false;
  return true;
}

export function refEqual<T = unknown>(
  a: DocumentReference<T> | CollectionReference<T>,
  b: DocumentReference<T> | CollectionReference<T>,
): boolean {
  if (!isReferenceHandle(a) || !isReferenceHandle(b)) {
    return false;
  }
  const targetA = refToTarget.get(a);
  const targetB = refToTarget.get(b);
  if (targetA === undefined || targetB === undefined) {
    return false;
  }
  if (!targetsShareOwner(targetA, targetB)) return false;
  if ((converterOf(a) ?? null) !== (converterOf(b) ?? null)) return false;
  const underA = underlyingOf(a) as { path?: unknown; doc?: unknown };
  const underB = underlyingOf(b) as { path?: unknown; doc?: unknown };
  if (typeof underA.path !== 'string' || typeof underB.path !== 'string') {
    return false;
  }
  if ((typeof underA.doc === 'function') !== (typeof underB.doc === 'function')) return false;
  return underA.path === underB.path;
}

export function queryEqual(a: Query, b: Query): boolean {
  const [targetA, targetB] = assertRecognizedPair(a as object, b as object);
  if (!targetsShareOwner(targetA, targetB)) return false;
  if ((converterOf(a as object) ?? null) !== (converterOf(b as object) ?? null)) return false;
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
