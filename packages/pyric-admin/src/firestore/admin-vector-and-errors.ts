/**
 * Admin-SDK `VectorValue` (`FieldValue.vector`) and `FirebaseFirestoreError`
 * implementations across local and JSON-wire remote sandboxes.
 */

import { isPlainMap } from './admin-handle-registry.js';

const ADMIN_VECTOR_WIRE_KEY = '__pyric_admin_vector_v1__';

type EncodedVectorElement = number | 'NaN' | 'Infinity' | '-Infinity';

function numberValuesEqual(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  return a === b;
}

export class AdminVectorValue {
  private readonly values: readonly number[];

  constructor(values: readonly number[]) {
    this.values = [...values];
  }

  toArray(): number[] {
    return [...this.values];
  }

  isEqual(other: unknown): boolean {
    if (this === other) {
      return true;
    }
    if (!(other instanceof AdminVectorValue)) {
      return false;
    }
    if (this.values.length !== other.values.length) {
      return false;
    }
    for (let i = 0; i < this.values.length; i += 1) {
      const left = this.values[i] as number;
      const right = other.values[i] as number;
      if (!numberValuesEqual(left, right)) {
        return false;
      }
    }
    return true;
  }
}

export function isAdminVectorValue(value: unknown): value is AdminVectorValue {
  return value instanceof AdminVectorValue;
}

export function createAdminVector(values?: readonly number[]): AdminVectorValue {
  if (values === undefined) {
    return new AdminVectorValue([]);
  }
  if (!Array.isArray(values)) {
    throw new TypeError('Value for argument "values" must be an array of numbers.');
  }
  const copied: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const item = values[i];
    if (typeof item !== 'number') {
      throw new Error(`Element at index ${i} is not a valid number.`);
    }
    copied.push(item);
  }
  return new AdminVectorValue(copied);
}

export function encodeAdminVectorForWire(vector: AdminVectorValue): Record<string, unknown> {
  const encoded: EncodedVectorElement[] = vector.toArray().map((n) => {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Number.POSITIVE_INFINITY) return 'Infinity';
    if (n === Number.NEGATIVE_INFINITY) return '-Infinity';
    return n;
  });
  return { [ADMIN_VECTOR_WIRE_KEY]: encoded };
}

export function tryDecodeAdminVectorFromWire(value: unknown): AdminVectorValue | undefined {
  if (!isPlainMap(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ADMIN_VECTOR_WIRE_KEY) {
    return undefined;
  }
  const rawArr = value[ADMIN_VECTOR_WIRE_KEY];
  if (!Array.isArray(rawArr)) {
    return undefined;
  }
  const nums: number[] = [];
  for (const item of rawArr) {
    if (typeof item === 'number') {
      nums.push(item);
    } else if (item === 'NaN') {
      nums.push(Number.NaN);
    } else if (item === 'Infinity') {
      nums.push(Number.POSITIVE_INFINITY);
    } else if (item === '-Infinity') {
      nums.push(Number.NEGATIVE_INFINITY);
    } else {
      return undefined;
    }
  }
  return new AdminVectorValue(nums);
}

export interface FirebaseFirestoreErrorInfo {
  readonly code: string;
  readonly message: string;
}

export class FirebaseFirestoreError extends Error {
  readonly code: string;

  constructor(info: FirebaseFirestoreErrorInfo) {
    super(info.message);
    this.name = 'FirebaseFirestoreError';
    this.code = `firestore/${info.code}`;
    Object.setPrototypeOf(this, FirebaseFirestoreError.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
    };
  }
}
