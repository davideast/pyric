/**
 * Admin-SDK write payload, `FieldValue` sentinel, `SetOptions`, `Precondition`,
 * and `DocumentReference` validation (`@google-cloud/firestore` parity across
 * local and JSON-wire remote sandboxes).
 */

import {
  Bytes as InternalBytes,
  Reference as InternalReference,
} from 'pyric/rules/internal';
import {
  FieldPath,
  FieldValue as CompatFieldValue,
  isValidTimestampComponents,
  registeredAdminReferencePath,
  Timestamp as CompatTimestamp,
  type AuthContext,
  type DocumentData,
  type FieldValueSentinel,
  type OperationOptions,
  type SetOptions,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import { adminDocumentRefBrand } from './admin-handle-registry.js';

const MAX_OBJECT_DEPTH = 20;
const MIN_INT64 = -9223372036854775808n;
const MAX_INT64 = 9223372036854775807n;
const FORBIDDEN_STRING_FIELD_PATH = /[*~/[\]]/;

export const UNESCAPED_MAP_TAG = Symbol.for('pyric.unescapedMap');
const SENTINEL_REGISTRY_KEY = Symbol.for('pyric.firestore.field-value-sentinels');

const SENTINEL_TYPES: ReadonlySet<string> = new Set([
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
]);

function isBrandedSentinelObject(value: object): boolean {
  const store = (globalThis as { [SENTINEL_REGISTRY_KEY]?: WeakSet<object> })[
    SENTINEL_REGISTRY_KEY
  ];
  return store !== undefined && store.has(value);
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isPlainDocumentObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectRecord(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFieldValueSentinel(
  value: unknown,
  requireSentinelBrand: boolean,
): value is FieldValueSentinel {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if ((value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true) {
    return false;
  }
  if (requireSentinelBrand && !isBrandedSentinelObject(value)) {
    return false;
  }
  const rawType = (value as { __type?: unknown }).__type;
  return typeof rawType === 'string' && SENTINEL_TYPES.has(rawType);
}

function hasMarkerCollisionKeys(map: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(map, '__type') ||
    Object.hasOwn(map, 'type') ||
    Object.hasOwn(map, '__type__') ||
    Object.hasOwn(map, '_methodName') ||
    Object.hasOwn(map, 'typeName') ||
    (Object.hasOwn(map, 'id') && Object.hasOwn(map, 'path'))
  );
}

export function isFieldPathInstance(value: unknown): value is FieldPath {
  if (value instanceof FieldPath) {
    return true;
  }
  return (
    value !== null &&
    typeof value === 'object' &&
    !isPlainDocumentObject(value) &&
    '_internalPath' in value
  );
}

export function assertAdminDocumentReference(argName: string, value: unknown): void {
  if (value !== null && typeof value === 'object') {
    if (adminDocumentRefBrand.has(value) || registeredAdminReferencePath(value) !== undefined) {
      return;
    }
  }
  throw new SandboxError(
    'invalid-argument',
    `Value for argument "${argName}" is not a valid DocumentReference.`,
  );
}

export function validateStringOrFieldPath(
  arg: string | number,
  field: unknown,
): readonly string[] {
  if (isFieldPathInstance(field)) {
    return field._internalPath.segments;
  }
  let label: string;
  if (typeof arg === 'string') {
    label = `Value for argument "${arg}"`;
  } else {
    label = `Element at index ${arg}`;
  }
  const prefix = `${label} is not a valid field path.`;
  if (field === undefined) {
    throw new SandboxError('invalid-argument', `${prefix} The path cannot be omitted.`);
  }
  if (typeof field !== 'string') {
    throw new SandboxError(
      'invalid-argument',
      `${prefix} Paths can only be specified as strings or via a FieldPath object.`,
    );
  }
  if (field.includes('..')) {
    throw new SandboxError('invalid-argument', `${prefix} Paths must not contain ".." in them.`);
  }
  if (field.startsWith('.') || field.endsWith('.')) {
    throw new SandboxError(
      'invalid-argument',
      `${prefix} Paths must not start or end with ".".`,
    );
  }
  if (field.length === 0 || FORBIDDEN_STRING_FIELD_PATH.test(field)) {
    throw new SandboxError(
      'invalid-argument',
      `${prefix} Paths can't be empty and must not contain "*~/[]".`,
    );
  }
  return field.split('.');
}

export interface ValueValidationContext {
  readonly arg: string | number;
  readonly allowDeletes: 'none' | 'root' | 'all';
  readonly allowTransforms: boolean;
  readonly requireSentinelBrand: boolean;
  readonly level: number;
  readonly pathLength: number;
  readonly inArray: boolean;
  readonly directArrayElement: boolean;
}

export function validateAndNormalizeFirestoreValue(
  value: unknown,
  ctx: ValueValidationContext,
): unknown {
  if (ctx.pathLength > MAX_OBJECT_DEPTH) {
    throw new SandboxError(
      'invalid-argument',
      `Input object is deeper than ${MAX_OBJECT_DEPTH} levels or contains a cycle.`,
    );
  }

  if (value === undefined) {
    throw new SandboxError(
      'invalid-argument',
      'Cannot use "undefined" as a Firestore value. If you want to ignore undefined values, enable `ignoreUndefinedProperties`.',
    );
  }

  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    if (value < MIN_INT64 || value > MAX_INT64) {
      throw new SandboxError(
        'invalid-argument',
        'BigInt value is out of signed 64-bit integer range.',
      );
    }
    return Number(value);
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SandboxError('invalid-argument', 'Cannot encode unsupported JavaScript value.');
  }

  if (Array.isArray(value)) {
    if (ctx.directArrayElement) {
      throw new SandboxError('invalid-argument', 'Nested arrays are not supported.');
    }
    return value.map((entry) =>
      validateAndNormalizeFirestoreValue(entry, {
        arg: ctx.arg,
        allowDeletes: ctx.allowDeletes,
        allowTransforms: ctx.allowTransforms,
        requireSentinelBrand: ctx.requireSentinelBrand,
        level: ctx.level + 1,
        pathLength: ctx.pathLength + 1,
        inArray: true,
        directArrayElement: true,
      }),
    );
  }

  if (isFieldValueSentinel(value, ctx.requireSentinelBrand)) {
    if (value.__type === 'deleteField') {
      if (ctx.inArray) {
        throw new SandboxError(
          'invalid-argument',
          'FieldValue.delete() cannot be used inside of an array.',
        );
      }
      if (ctx.allowDeletes === 'none') {
        throw new SandboxError(
          'invalid-argument',
          'FieldValue.delete() must appear at the top-level and can only be used in update() or set() with {merge:true}.',
        );
      }
      const allowedAtRoot = ctx.level === 0 || (ctx.level === 1 && ctx.pathLength === 1);
      if (ctx.allowDeletes === 'root' && !allowedAtRoot) {
        throw new SandboxError(
          'invalid-argument',
          'FieldValue.delete() must appear at the top-level and can only be used in update() or set() with {merge:true}.',
        );
      }
      return value;
    }

    if (ctx.inArray) {
      throw new SandboxError(
        'invalid-argument',
        `FieldValue.${value.__type}() cannot be used inside of an array.`,
      );
    }
    if (!ctx.allowTransforms) {
      throw new SandboxError(
        'invalid-argument',
        `FieldValue.${value.__type}() can only be used in set(), create() or update().`,
      );
    }
    if (value.__type === 'increment') {
      if (typeof value.value !== 'number' || Number.isNaN(value.value)) {
        throw new SandboxError(
          'invalid-argument',
          'Value for argument "FieldValue.increment()" is not a valid number.',
        );
      }
      return value;
    }
    if (value.__type === 'arrayUnion' || value.__type === 'arrayRemove') {
      const normalizedElements = value.values.map((entry, idx) =>
        validateAndNormalizeFirestoreValue(entry, {
          arg: idx,
          allowDeletes: 'none',
          allowTransforms: false,
          requireSentinelBrand: ctx.requireSentinelBrand,
          level: 0,
          pathLength: 0,
          inArray: true,
          directArrayElement: true,
        }),
      );
      if (value.__type === 'arrayUnion') {
        return CompatFieldValue.arrayUnion(...normalizedElements);
      }
      return CompatFieldValue.arrayRemove(...normalizedElements);
    }
    return value;
  }

  if (value instanceof CompatTimestamp) {
    if (!isValidTimestampComponents(value.seconds, value.nanoseconds)) {
      throw new SandboxError(
        'invalid-argument',
        `Invalid Timestamp(seconds=${String(value.seconds)}, nanoseconds=${String(value.nanoseconds)})`,
      );
    }
    return value;
  }

  if (value instanceof Date) {
    const millis = value.getTime();
    if (!Number.isFinite(millis)) {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "seconds" is not a valid integer.',
      );
    }
    return CompatTimestamp.fromMillis(millis);
  }

  const referencePath = registeredAdminReferencePath(value);
  if (referencePath !== undefined) {
    return new InternalReference(referencePath);
  }

  if (value instanceof Uint8Array) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new InternalBytes(view.slice());
  }

  if (isFieldPathInstance(value)) {
    throw new SandboxError(
      'invalid-argument',
      'Cannot use object of type "FieldPath" as a Firestore value.',
    );
  }

  if (isPlainDocumentObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (key.length === 0) {
        throw new SandboxError(
          'invalid-argument',
          'Element at index 0 should not be an empty string.',
        );
      }
      Object.defineProperty(out, key, {
        value: validateAndNormalizeFirestoreValue(value[key], {
          arg: ctx.arg,
          allowDeletes: ctx.allowDeletes,
          allowTransforms: ctx.allowTransforms,
          requireSentinelBrand: ctx.requireSentinelBrand,
          level: ctx.level + 1,
          pathLength: ctx.pathLength + 1,
          inArray: ctx.inArray,
          directArrayElement: false,
        }),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const sourceTagged = (value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true;
    if (sourceTagged || hasMarkerCollisionKeys(out)) {
      Object.defineProperty(out, UNESCAPED_MAP_TAG, { value: true });
    }
    return out;
  }

  throw new SandboxError(
    'invalid-argument',
    'Firestore does not support JavaScript objects with custom prototypes.',
  );
}

export function validateAndNormalizeDocumentData(
  argName: string,
  data: unknown,
  allowDeletes: 'none' | 'all',
  requireSentinelBrand: boolean,
): DocumentData {
  if (!isPlainDocumentObject(data)) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid Firestore document. Input is not a plain JavaScript object.`,
    );
  }
  return validateAndNormalizeFirestoreValue(data, {
    arg: argName,
    allowDeletes,
    allowTransforms: true,
    requireSentinelBrand,
    level: 0,
    pathLength: 0,
    inArray: false,
    directArrayElement: false,
  }) as DocumentData;
}

export function compareFieldSegments(left: readonly string[], right: readonly string[]): number {
  const minLen = Math.min(left.length, right.length);
  for (let i = 0; i < minLen; i += 1) {
    const a = left[i] ?? '';
    const b = right[i] ?? '';
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return left.length - right.length;
}

function deduplicateSortedPaths(
  paths: ReadonlyArray<readonly string[]>,
): Array<readonly string[]> {
  const sorted = [...paths].sort(compareFieldSegments);
  const unique: Array<readonly string[]> = [];
  for (const segs of sorted) {
    const prev = unique[unique.length - 1];
    if (prev === undefined || compareFieldSegments(prev, segs) !== 0) {
      unique.push(segs);
    }
  }
  return unique;
}

function verifyMaskPathsPresentInData(
  data: Record<string, unknown>,
  sortedUniquePaths: ReadonlyArray<readonly string[]>,
): void {
  const remaining = new Set<number>(sortedUniquePaths.map((_, idx) => idx));

  function findExactMaskIndex(candidate: readonly string[]): number {
    for (let i = 0; i < sortedUniquePaths.length; i += 1) {
      const target = sortedUniquePaths[i];
      if (target !== undefined && compareFieldSegments(target, candidate) === 0) {
        return i;
      }
    }
    return -1;
  }

  function walkObject(current: Record<string, unknown>, prefix: readonly string[]): void {
    for (const key of Object.keys(current)) {
      const childPath = [...prefix, key];
      const matchedIdx = findExactMaskIndex(childPath);
      if (matchedIdx !== -1) {
        remaining.delete(matchedIdx);
      } else {
        const childVal = current[key];
        if (isPlainDocumentObject(childVal)) {
          walkObject(childVal, childPath);
        }
      }
    }
  }

  walkObject(data, []);

  for (let i = 0; i < sortedUniquePaths.length; i += 1) {
    if (remaining.has(i)) {
      const missingSegs = sortedUniquePaths[i] ?? [];
      const formatted = new FieldPath(...missingSegs).toString();
      throw new SandboxError('invalid-argument', `Input data is missing for field "${formatted}".`);
    }
  }
}

function copyOptionalAuth(source: Record<string, unknown>, target: SetOptions): void {
  if ('auth' in source) {
    target.auth = source.auth as AuthContext;
  }
}

export function validateAndNormalizeSetCall(
  data: unknown,
  rawOptions: unknown,
  coerceFalsyOptions: boolean,
  requireSentinelBrand: boolean,
): { data: DocumentData; options: SetOptions | undefined } {
  let effectiveOptions = rawOptions;
  if (coerceFalsyOptions && !rawOptions) {
    effectiveOptions = undefined;
  }

  if (effectiveOptions === undefined) {
    return {
      data: validateAndNormalizeDocumentData('data', data, 'none', requireSentinelBrand),
      options: undefined,
    };
  }

  if (!isObjectRecord(effectiveOptions)) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "options" is not a valid set() options argument. Input is not an object.',
    );
  }

  const hasMergeKey = 'merge' in effectiveOptions;
  const hasMergeFieldsKey = 'mergeFields' in effectiveOptions;
  if (hasMergeKey && hasMergeFieldsKey) {
    throw new SandboxError(
      'invalid-argument',
      'Value for argument "options" is not a valid set() options argument. You cannot specify both "merge" and "mergeFields".',
    );
  }

  let sortedUniqueMask: Array<readonly string[]> | undefined;
  if (hasMergeFieldsKey) {
    const rawMask = effectiveOptions.mergeFields;
    const rawLength = (rawMask as { length: number }).length;
    for (let i = 0; i < rawLength; i += 1) {
      validateStringOrFieldPath(i, (rawMask as Record<number, unknown>)[i]);
    }
    const maskInputs: Array<readonly string[]> = [];
    for (const item of rawMask as Iterable<unknown>) {
      maskInputs.push(validateStringOrFieldPath('mergeFields', item));
    }
    sortedUniqueMask = deduplicateSortedPaths(maskInputs);
  }

  const mergeLeaves = hasMergeKey && Boolean(effectiveOptions.merge);
  let allowDeletes: 'none' | 'all' = 'none';
  if (mergeLeaves || hasMergeFieldsKey) {
    allowDeletes = 'all';
  }
  const normalizedData = validateAndNormalizeDocumentData(
    'data',
    data,
    allowDeletes,
    requireSentinelBrand,
  );

  if (sortedUniqueMask !== undefined) {
    verifyMaskPathsPresentInData(normalizedData, sortedUniqueMask);
    const outOptions: SetOptions = {
      mergeFields: sortedUniqueMask.map((segs) => new FieldPath(...segs)),
    };
    copyOptionalAuth(effectiveOptions, outOptions);
    return { data: normalizedData, options: outOptions };
  }

  if (hasMergeKey) {
    const outOptions: SetOptions = { merge: mergeLeaves };
    copyOptionalAuth(effectiveOptions, outOptions);
    return { data: normalizedData, options: outOptions };
  }

  const outOptions: SetOptions = {};
  copyOptionalAuth(effectiveOptions, outOptions);
  return { data: normalizedData, options: outOptions };
}

export function validatePreconditionObject(
  argName: string,
  precondition: unknown,
  forbidExistsFalse = false,
): OperationOptions | undefined {
  if (precondition === undefined) {
    return undefined;
  }
  if (typeof precondition !== 'object' || precondition === null) {
    throw new SandboxError('invalid-argument', 'Input is not an object.');
  }
  const record = precondition as Record<string, unknown>;
  const existsVal = record.exists;
  const lastUpdateVal = record.lastUpdateTime;
  if (existsVal !== undefined) {
    if (typeof existsVal !== 'boolean') {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "${argName}" is not a valid precondition. "exists" is not a boolean.`,
      );
    }
    if (forbidExistsFalse && existsVal === false) {
      throw new SandboxError(
        'invalid-argument',
        `Value for argument "${argName}" is not a valid precondition. "exists" is not allowed to have the value false (allowed values: true)`,
      );
    }
  }
  if (lastUpdateVal !== undefined && !(lastUpdateVal instanceof CompatTimestamp)) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid precondition. "lastUpdateTime" is not a Firestore Timestamp.`,
    );
  }
  if (existsVal !== undefined && lastUpdateVal !== undefined) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid precondition. Input specifies more than one precondition.`,
    );
  }
  if ('auth' in record) {
    return { auth: record.auth as AuthContext };
  }
  return undefined;
}
