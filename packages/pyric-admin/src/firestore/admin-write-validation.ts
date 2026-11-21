/**
 * Admin-SDK write payload, `FieldValue` sentinel, `SetOptions`, `Precondition`,
 * and `DocumentReference` validation (`@google-cloud/firestore` parity across
 * local and JSON-wire remote sandboxes).
 */

import {
  Bytes as InternalBytes,
  LatLng as InternalLatLng,
  Reference as InternalReference,
} from 'pyric/rules/internal';
import {
  FieldPath,
  FieldValue as CompatFieldValue,
  isValidTimestampComponents,
  registeredAdminReferencePath,
  Timestamp as CompatTimestamp,
  type DocumentData,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import {
  formatCustomObjectErrorMessage,
  formatFieldPathSuffix,
  formatSentinelMethodName,
  formatValueValidationPrefix,
} from './admin-error-messages.js';
import { isAdminGeoPoint } from './admin-geopoint.js';
import { adminDocumentRefBrand } from './admin-handle-registry.js';
import { encodeAdminVectorForWire, isAdminVectorValue } from './admin-vector-and-errors.js';

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
  readonly expectedType?: string;
  readonly leadingMessage?: string;
  readonly segments?: readonly string[];
  readonly allowDeletes: 'none' | 'root' | 'all';
  readonly allowTransforms: boolean;
  readonly requireSentinelBrand: boolean;
  readonly level: number;
  readonly pathLength: number;
  readonly inArray: boolean;
  readonly directArrayElement: boolean;
  readonly arrayElementValidator?: boolean;
}

export function validateAndNormalizeFirestoreValue(
  value: unknown,
  ctx: ValueValidationContext,
): unknown {
  const segments = ctx.segments ?? [];
  const prefix = formatValueValidationPrefix(ctx.arg, ctx.expectedType, ctx.leadingMessage);
  const pathSuffix = formatFieldPathSuffix(segments);

  if (ctx.pathLength > MAX_OBJECT_DEPTH) {
    throw new SandboxError(
      'invalid-argument',
      `${prefix}Input object is deeper than ${MAX_OBJECT_DEPTH} levels or contains a cycle.`,
    );
  }

  if (value === undefined) {
    throw new SandboxError(
      'invalid-argument',
      `${prefix}Cannot use "undefined" as a Firestore value${pathSuffix}. If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`,
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

  if (typeof value === 'function') {
    throw new SandboxError('invalid-argument', `Cannot encode value: ${String(value)}`);
  }
  if (typeof value === 'symbol') {
    throw new SandboxError('invalid-argument', 'Cannot convert a symbol to a string');
  }

  if (Array.isArray(value)) {
    if (ctx.directArrayElement) {
      if (ctx.arrayElementValidator === true) {
        throw new SandboxError('invalid-argument', `${prefix}Nested arrays are not supported.`);
      }
      throw new SandboxError(
        'invalid-argument',
        'Cannot convert an array value in an array value.',
      );
    }
    return value.map((entry, idx) =>
      validateAndNormalizeFirestoreValue(entry, {
        arg: ctx.arg,
        expectedType: ctx.expectedType,
        leadingMessage: ctx.leadingMessage,
        segments: [...segments, String(idx)],
        allowDeletes: ctx.allowDeletes,
        allowTransforms: ctx.allowTransforms,
        requireSentinelBrand: ctx.requireSentinelBrand,
        level: ctx.level + 1,
        pathLength: ctx.pathLength + 1,
        inArray: true,
        directArrayElement: true,
        arrayElementValidator: false,
      }),
    );
  }

  if (isFieldValueSentinel(value, ctx.requireSentinelBrand)) {
    if (value.__type === 'deleteField') {
      if (ctx.inArray) {
        throw new SandboxError(
          'invalid-argument',
          `${prefix}FieldValue.delete() cannot be used inside of an array${pathSuffix}.`,
        );
      }
      if (ctx.allowDeletes === 'none') {
        throw new SandboxError(
          'invalid-argument',
          `${prefix}FieldValue.delete() must appear at the top-level and can only be used in update() or set() with {merge:true}${pathSuffix}.`,
        );
      }
      const allowedAtRoot = ctx.level === 0 || (ctx.level === 1 && ctx.pathLength === 1);
      if (ctx.allowDeletes === 'root' && !allowedAtRoot) {
        throw new SandboxError(
          'invalid-argument',
          `${prefix}FieldValue.delete() must appear at the top-level and can only be used in update() or set() with {merge:true}${pathSuffix}.`,
        );
      }
      return value;
    }

    const methodName = formatSentinelMethodName(value.__type);
    if (ctx.inArray) {
      throw new SandboxError(
        'invalid-argument',
        `${prefix}${methodName}() cannot be used inside of an array${pathSuffix}.`,
      );
    }
    if (!ctx.allowTransforms) {
      throw new SandboxError(
        'invalid-argument',
        `${prefix}${methodName}() can only be used in set(), create() or update()${pathSuffix}.`,
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
          expectedType: 'array element',
          segments: [],
          allowDeletes: 'none',
          allowTransforms: false,
          requireSentinelBrand: ctx.requireSentinelBrand,
          level: 0,
          pathLength: 0,
          inArray: true,
          directArrayElement: true,
          arrayElementValidator: true,
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

  if (isAdminGeoPoint(value)) return new InternalLatLng(value.latitude, value.longitude);
  if (isAdminVectorValue(value)) return encodeAdminVectorForWire(value);

  if (isFieldPathInstance(value)) {
    throw new SandboxError(
      'invalid-argument',
      `${prefix}Cannot use object of type "FieldPath" as a Firestore value${pathSuffix}.`,
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
          expectedType: ctx.expectedType,
          leadingMessage: ctx.leadingMessage,
          segments: [...segments, key],
          allowDeletes: ctx.allowDeletes,
          allowTransforms: ctx.allowTransforms,
          requireSentinelBrand: ctx.requireSentinelBrand,
          level: ctx.level + 1,
          pathLength: ctx.pathLength + 1,
          inArray: ctx.inArray,
          directArrayElement: false,
          arrayElementValidator: false,
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
    formatCustomObjectErrorMessage(
      ctx.arg,
      ctx.expectedType,
      ctx.leadingMessage,
      value,
      segments,
    ),
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
      formatCustomObjectErrorMessage(argName, 'Firestore document', undefined, data, []),
    );
  }
  return validateAndNormalizeFirestoreValue(data, {
    arg: argName,
    expectedType: 'Firestore document',
    segments: [],
    allowDeletes,
    allowTransforms: true,
    requireSentinelBrand,
    level: 0,
    pathLength: 0,
    inArray: false,
    directArrayElement: false,
    arrayElementValidator: false,
  }) as DocumentData;
}
