interface FirestoreValueComparable {
  isEqual(other: unknown): boolean;
}

function hasFirestoreValueEquality(value: unknown): value is FirestoreValueComparable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isEqual' in value &&
    typeof (value as { isEqual?: unknown }).isEqual === 'function'
  );
}

function isFirestoreMapValue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type FirestoreScalar =
  | { kind: 'timestamp'; seconds: number; nanoseconds: number }
  | { kind: 'bytes'; values: readonly number[] }
  | { kind: 'geo-point'; latitude: number; longitude: number }
  | { kind: 'reference'; path: string }
  | { kind: 'vector'; values: readonly number[] };

/** Normalize scalar wrappers across the modular, admin-compat, and rules
 * runtimes. Those packages intentionally use different classes, so relying
 * on either side's `instanceof`-based `isEqual` loses value equality. */
function firestoreScalar(value: unknown): FirestoreScalar | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // Firestore maps may legitimately contain keys such as `seconds`, `path`,
  // or `latitude`. Only class/registered wrapper values are scalars; treating
  // a plain map as one collapses distinct Firestore types during equality.
  if (isFirestoreMapValue(value)) return undefined;
  const candidate = value as Record<string, unknown> & {
    toUint8Array?: () => Uint8Array;
    toArray?: () => number[];
  };
  if (typeof candidate.seconds === 'number') {
    const nanoseconds = typeof candidate.nanoseconds === 'number'
      ? candidate.nanoseconds
      : candidate.nanos;
    if (typeof nanoseconds === 'number') {
      return { kind: 'timestamp', seconds: candidate.seconds, nanoseconds };
    }
  }
  if (candidate.data instanceof Uint8Array) {
    return { kind: 'bytes', values: Array.from(candidate.data) };
  }
  if (typeof candidate.toUint8Array === 'function') {
    return { kind: 'bytes', values: Array.from(candidate.toUint8Array()) };
  }
  if (typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number') {
    return {
      kind: 'geo-point',
      latitude: candidate.latitude,
      longitude: candidate.longitude,
    };
  }
  if (typeof candidate.lat === 'number' && typeof candidate.lng === 'number') {
    return {
      kind: 'geo-point',
      latitude: candidate.lat,
      longitude: candidate.lng,
    };
  }
  if (typeof candidate.path === 'string') {
    return { kind: 'reference', path: candidate.path };
  }
  if (candidate.typeName === 'vector' && Array.isArray(candidate.value)) {
    return { kind: 'vector', values: candidate.value as number[] };
  }
  if (typeof candidate.toArray === 'function') {
    return { kind: 'vector', values: candidate.toArray() };
  }
  return undefined;
}

export function firestoreValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  const aScalar = firestoreScalar(a);
  const bScalar = firestoreScalar(b);
  if (aScalar !== undefined || bScalar !== undefined) {
    if (aScalar === undefined || bScalar === undefined || aScalar.kind !== bScalar.kind) return false;
    switch (aScalar.kind) {
      case 'timestamp':
        return bScalar.kind === 'timestamp'
          && aScalar.seconds === bScalar.seconds
          && aScalar.nanoseconds === bScalar.nanoseconds;
      case 'bytes':
        return bScalar.kind === 'bytes'
          && aScalar.values.length === bScalar.values.length
          && aScalar.values.every((entry, index) => entry === bScalar.values[index]);
      case 'vector':
        return bScalar.kind === 'vector'
          && aScalar.values.length === bScalar.values.length
          && aScalar.values.every((entry, index) => entry === bScalar.values[index]);
      case 'geo-point':
        return bScalar.kind === 'geo-point'
          && aScalar.latitude === bScalar.latitude
          && aScalar.longitude === bScalar.longitude;
      case 'reference':
        return bScalar.kind === 'reference' && aScalar.path === bScalar.path;
    }
  }
  if (hasFirestoreValueEquality(a)) return a.isEqual(b);
  if (hasFirestoreValueEquality(b)) return b.isEqual(a);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => firestoreValuesEqual(value, b[index]));
  }
  if (!isFirestoreMapValue(a) || !isFirestoreMapValue(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in b && firestoreValuesEqual(a[key], b[key]));
}
