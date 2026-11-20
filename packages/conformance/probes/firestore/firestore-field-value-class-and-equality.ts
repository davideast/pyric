import type { Probe } from '../../rigs/types.ts';

interface SentinelComparable {
  isEqual(other: unknown): boolean;
}

export interface FieldValueClassAndEqualitySubject {
  readonly FieldValue: Function;
  deleteField(): unknown;
  serverTimestamp(): unknown;
  increment(n: number): unknown;
  arrayUnion(...elements: unknown[]): unknown;
  arrayRemove(...elements: unknown[]): unknown;
  vector(values?: number[]): unknown;
}

function checkIsEqual(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== 'object') {
    return false;
  }
  const candidate = left as { isEqual?: unknown };
  if (typeof candidate.isEqual !== 'function') {
    return false;
  }
  return Boolean((candidate as SentinelComparable).isEqual(right));
}

function hasIsEqualFn(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return typeof (value as { isEqual?: unknown }).isEqual === 'function';
}

export function observeFirestoreFieldValueClassAndEquality(
  subject: FieldValueClassAndEqualitySubject,
): Record<string, unknown> {
  const FieldValueCtor = subject.FieldValue as unknown as Function;
  const del1 = subject.deleteField();
  const del2 = subject.deleteField();
  const ts1 = subject.serverTimestamp();
  const ts2 = subject.serverTimestamp();
  const inc2a = subject.increment(2);
  const inc2b = subject.increment(2);
  const inc3 = subject.increment(3);
  const incNaN1 = subject.increment(Number.NaN);
  const incNaN2 = subject.increment(Number.NaN);
  const incZero = subject.increment(0);
  const incNegZero = subject.increment(-0);
  const unionA1 = subject.arrayUnion('alpha', 1);
  const unionA2 = subject.arrayUnion('alpha', 1);
  const unionOrderFlipped = subject.arrayUnion(1, 'alpha');
  const unionMap1 = subject.arrayUnion({ nested: 'v1', count: 2 });
  const unionMap2 = subject.arrayUnion({ count: 2, nested: 'v1' });
  const unionSingle = subject.arrayUnion('alpha');
  const removeA1 = subject.arrayRemove('alpha');
  const removeA2 = subject.arrayRemove('alpha');
  const removeB = subject.arrayRemove('beta');
  const vec1 = subject.vector([1, 2]);

  return {
    isFieldValueExportFunction: typeof FieldValueCtor === 'function',
    instanceOfChecks: {
      deleteField: del1 instanceof FieldValueCtor,
      serverTimestamp: ts1 instanceof FieldValueCtor,
      increment: inc2a instanceof FieldValueCtor,
      arrayUnion: unionA1 instanceof FieldValueCtor,
      arrayRemove: removeA1 instanceof FieldValueCtor,
      vector: vec1 instanceof FieldValueCtor,
    },
    hasIsEqualMethod: {
      deleteField: hasIsEqualFn(del1),
      serverTimestamp: hasIsEqualFn(ts1),
      increment: hasIsEqualFn(inc2a),
      arrayUnion: hasIsEqualFn(unionA1),
      arrayRemove: hasIsEqualFn(removeA1),
    },
    equalityChecks: {
      deleteFieldSelf: checkIsEqual(del1, del2),
      deleteFieldVsServerTimestamp: checkIsEqual(del1, ts1),
      serverTimestampSelf: checkIsEqual(ts1, ts2),
      serverTimestampVsIncrement: checkIsEqual(ts1, inc2a),
      incrementSameFinite: checkIsEqual(inc2a, inc2b),
      incrementDifferentFinite: checkIsEqual(inc2a, inc3),
      incrementNaNSelf: checkIsEqual(incNaN1, incNaN2),
      incrementZeroAndNegZero: checkIsEqual(incZero, incNegZero),
      arrayUnionSameOrderAndTypes: checkIsEqual(unionA1, unionA2),
      arrayUnionDifferentOrder: checkIsEqual(unionA1, unionOrderFlipped),
      arrayUnionNestedMapSame: checkIsEqual(unionMap1, unionMap2),
      arrayUnionVsArrayRemoveSameArgs: checkIsEqual(unionSingle, removeA1),
      arrayRemoveSameArgs: checkIsEqual(removeA1, removeA2),
      arrayRemoveDifferentArgs: checkIsEqual(removeA1, removeB),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'firestore#105',
  rowIds: ['firestore#105'],
  description:
    'firebase/firestore FieldValue runtime base class inheritance across deleteField, serverTimestamp, increment, arrayUnion, and arrayRemove (excluding vector) and per-sentinel isEqual structural comparison.',
  async observe(): Promise<Record<string, unknown>> {
    const fsMod = await import('firebase/firestore');
    return observeFirestoreFieldValueClassAndEquality({
      FieldValue: fsMod.FieldValue,
      deleteField: () => fsMod.deleteField(),
      serverTimestamp: () => fsMod.serverTimestamp(),
      increment: (n: number) => fsMod.increment(n),
      arrayUnion: (...elements: unknown[]) => fsMod.arrayUnion(...elements),
      arrayRemove: (...elements: unknown[]) => fsMod.arrayRemove(...elements),
      vector: (values?: number[]) => fsMod.vector(values),
    });
  },
};
