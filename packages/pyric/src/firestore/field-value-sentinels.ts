import type { FieldValueSentinel } from 'pyric/sandbox/admin-firestore';
import { markFieldValueSentinel } from './sandbox/unescaped-map.js';

interface ComparableObject {
  isEqual(other: unknown): boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepSentinelValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const maybeComparable = left as { isEqual?: unknown };
  if (typeof maybeComparable.isEqual === 'function') {
    return Boolean((left as ComparableObject).isEqual(right));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, idx) => deepSentinelValueEqual(item, right[idx]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepSentinelValueEqual(left[key], right[key]));
}

function defineHiddenProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

export class FieldValue {
  declare readonly _methodName: string;

  constructor(methodName = '') {
    defineHiddenProperty(this, '_methodName', methodName);
  }

  isEqual(_other: unknown): boolean {
    return false;
  }

  static serverTimestamp(): FieldValue & FieldValueSentinel {
    return createServerTimestampSentinel();
  }

  static increment(n: number): FieldValue & FieldValueSentinel {
    return createIncrementSentinel(n);
  }

  static maximum(n: number): FieldValue & FieldValueSentinel {
    return createMaximumSentinel(n);
  }

  static minimum(n: number): FieldValue & FieldValueSentinel {
    return createMinimumSentinel(n);
  }

  static arrayUnion(...values: unknown[]): FieldValue & FieldValueSentinel {
    return createArrayUnionSentinel(values);
  }

  static arrayRemove(...values: unknown[]): FieldValue & FieldValueSentinel {
    return createArrayRemoveSentinel(values);
  }

  static delete(): FieldValue & FieldValueSentinel {
    return createDeleteFieldSentinel();
  }
}

class DeleteFieldValueImpl extends FieldValue {
  readonly __type = 'deleteField' as const;

  constructor() {
    super('deleteField');
    defineHiddenProperty(this, '__sentinel', 'deleteField');
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    return other instanceof DeleteFieldValueImpl;
  }
}

class ServerTimestampFieldValueImpl extends FieldValue {
  readonly __type = 'serverTimestamp' as const;

  constructor() {
    super('serverTimestamp');
    defineHiddenProperty(this, '__sentinel', 'serverTimestamp');
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    return other instanceof ServerTimestampFieldValueImpl;
  }
}

class NumericIncrementFieldValueImpl extends FieldValue {
  readonly __type = 'increment' as const;
  readonly value: number;

  constructor(operand: number) {
    super('increment');
    this.value = operand;
    defineHiddenProperty(this, '__sentinel', 'increment');
    defineHiddenProperty(this, 'n', operand);
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    if (!(other instanceof NumericIncrementFieldValueImpl)) {
      return false;
    }
    if (this.value === other.value) {
      return true;
    }
    return Number.isNaN(this.value) && Number.isNaN(other.value);
  }
}

class NumericMaximumFieldValueImpl extends FieldValue {
  readonly __type = 'maximum' as const;
  readonly value: number;

  constructor(operand: number) {
    super('maximum');
    this.value = operand;
    defineHiddenProperty(this, '__sentinel', 'maximum');
    defineHiddenProperty(this, 'n', operand);
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    if (!(other instanceof NumericMaximumFieldValueImpl)) {
      return false;
    }
    if (this.value === other.value) {
      return true;
    }
    return Number.isNaN(this.value) && Number.isNaN(other.value);
  }
}

class NumericMinimumFieldValueImpl extends FieldValue {
  readonly __type = 'minimum' as const;
  readonly value: number;

  constructor(operand: number) {
    super('minimum');
    this.value = operand;
    defineHiddenProperty(this, '__sentinel', 'minimum');
    defineHiddenProperty(this, 'n', operand);
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    if (!(other instanceof NumericMinimumFieldValueImpl)) {
      return false;
    }
    if (this.value === other.value) {
      return true;
    }
    return Number.isNaN(this.value) && Number.isNaN(other.value);
  }
}

class ArrayUnionFieldValueImpl extends FieldValue {
  readonly __type = 'arrayUnion' as const;
  readonly values: unknown[];

  constructor(elements: unknown[]) {
    super('arrayUnion');
    this.values = elements;
    defineHiddenProperty(this, '__sentinel', 'arrayUnion');
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    if (!(other instanceof ArrayUnionFieldValueImpl)) {
      return false;
    }
    return deepSentinelValueEqual(this.values, other.values);
  }
}

class ArrayRemoveFieldValueImpl extends FieldValue {
  readonly __type = 'arrayRemove' as const;
  readonly values: unknown[];

  constructor(elements: unknown[]) {
    super('arrayRemove');
    this.values = elements;
    defineHiddenProperty(this, '__sentinel', 'arrayRemove');
    markFieldValueSentinel(this);
  }

  override isEqual(other: unknown): boolean {
    if (!(other instanceof ArrayRemoveFieldValueImpl)) {
      return false;
    }
    return deepSentinelValueEqual(this.values, other.values);
  }
}

export function createDeleteFieldSentinel(): FieldValue & FieldValueSentinel {
  return new DeleteFieldValueImpl() as unknown as FieldValue & FieldValueSentinel;
}

export function createServerTimestampSentinel(): FieldValue & FieldValueSentinel {
  return new ServerTimestampFieldValueImpl() as unknown as FieldValue & FieldValueSentinel;
}

export function createIncrementSentinel(n: number): FieldValue & FieldValueSentinel {
  return new NumericIncrementFieldValueImpl(n) as unknown as FieldValue & FieldValueSentinel;
}

export function createMaximumSentinel(n: number): FieldValue & FieldValueSentinel {
  return new NumericMaximumFieldValueImpl(n) as unknown as FieldValue & FieldValueSentinel;
}

export function createMinimumSentinel(n: number): FieldValue & FieldValueSentinel {
  return new NumericMinimumFieldValueImpl(n) as unknown as FieldValue & FieldValueSentinel;
}

export function createArrayUnionSentinel(values: unknown[]): FieldValue & FieldValueSentinel {
  return new ArrayUnionFieldValueImpl(values) as unknown as FieldValue & FieldValueSentinel;
}

export function createArrayRemoveSentinel(values: unknown[]): FieldValue & FieldValueSentinel {
  return new ArrayRemoveFieldValueImpl(values) as unknown as FieldValue & FieldValueSentinel;
}
