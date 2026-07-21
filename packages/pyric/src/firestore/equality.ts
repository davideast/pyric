/** `pyric/firestore` — sandbox reference and snapshot equality helpers. */
import { targetOf, underlyingOf } from './state.js';
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
  return (underlyingOf(a) as { path: string }).path
    === (underlyingOf(b) as { path: string }).path;
}

export function queryEqual(a: Query, b: Query): boolean {
  assertRecognizedPair(a as object, b as object);
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
  return a === b;
}
