/**
 * Admin-SDK `Query` constraint validation and normalization (`where`, `orderBy`,
 * `limit`, `limitToLast`, and `FieldPath.documentId()` scope checks across
 * local and JSON-wire remote sandboxes).
 */

import { Reference as InternalReference } from 'pyric/rules/internal';
import {
  FieldPath,
  registeredAdminReferencePath,
  type DocumentData,
  type DocumentSnapshot,
  type Filter,
  type OrderDirection,
  type Query,
  type SnapshotFieldPath,
  type WhereFilterOp,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import {
  adminToUnderlying,
  isPlainMap,
  unwrapAdminObject,
} from './admin-handle-registry.js';
import { isAdminGeoPoint } from './admin-geopoint.js';
import { isAdminVectorValue } from './admin-vector-and-errors.js';
import {
  assertAdminDocumentReference,
  UNESCAPED_MAP_TAG,
  validateAndNormalizeFirestoreValue,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

type AdminQuerySource =
  | { readonly kind: 'collection'; readonly path: string }
  | { readonly kind: 'group'; readonly collectionId: string };

export interface AdminQueryMetadata {
  readonly source: AdminQuerySource;
  readonly signature: readonly string[];
  readonly orderByFields: ReadonlyArray<readonly string[]>;
  readonly hasExplicitOrderBy: boolean;
  readonly hasCursorBound?: boolean;
  readonly pendingLimitType: 'none' | 'first' | 'last';
  readonly offsetCount?: number;
  readonly limitCount?: number;
  readonly selectedFields?: ReadonlyArray<readonly string[]>;
  readonly startSignature?: string;
  readonly endSignature?: string;
  readonly isCollectionGroupRoot?: boolean;
  readonly replayOnRoot?: (db: SandboxFirestore) => Query;
}

export const adminQueryMetadata = new WeakMap<object, AdminQueryMetadata>();

const VALID_WHERE_OPERATORS: ReadonlySet<string> = new Set([
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  'in',
  'not-in',
  'array-contains',
  'array-contains-any',
]);

export function initialCollectionQueryMeta(path: string): AdminQueryMetadata {
  return {
    source: { kind: 'collection', path },
    signature: [`col:${path}`],
    orderByFields: [],
    hasExplicitOrderBy: false,
    pendingLimitType: 'none',
    replayOnRoot: (db) => db.collection(path),
  };
}

export function initialCollectionGroupQueryMeta(collectionId: string): AdminQueryMetadata {
  return {
    source: { kind: 'group', collectionId },
    signature: [`group:${collectionId}`],
    orderByFields: [],
    hasExplicitOrderBy: false,
    pendingLimitType: 'none',
    isCollectionGroupRoot: true,
    replayOnRoot: (db) => db.collectionGroup(collectionId),
  };
}

function toNormalizedQueryField(
  rawField: unknown,
  segments: readonly string[],
): SnapshotFieldPath {
  if (typeof rawField === 'string') {
    return rawField;
  }
  return new FieldPath(...segments);
}

function unwrapQueryOperandReferences(value: unknown, rootDb: SandboxFirestore): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const unwrapped = adminToUnderlying.get(value);
  if (unwrapped !== undefined) {
    return unwrapped;
  }
  if (value instanceof InternalReference) {
    return unwrapAdminObject(rootDb.doc(value.path));
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.prototype.slice.call(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => unwrapQueryOperandReferences(entry, rootDb));
  }
  if (isPlainMap(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: unwrapQueryOperandReferences(value[key], rootDb),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if ((value as Record<symbol, unknown>)[UNESCAPED_MAP_TAG] === true) {
      Object.defineProperty(out, UNESCAPED_MAP_TAG, { value: true });
    }
    return out;
  }
  return value;
}

export function normalizeLegacyQueryOperand(
  value: unknown,
  rootDb: SandboxFirestore,
): unknown {
  return unwrapQueryOperandReferences(value, rootDb);
}

export function normalizeCompositeFilter(filter: Filter, rootDb: SandboxFirestore): Filter {
  if (filter.kind === 'where') {
    return {
      kind: 'where',
      field: filter.field,
      op: filter.op,
      value: unwrapQueryOperandReferences(filter.value, rootDb),
    };
  }
  return {
    kind: filter.kind,
    filters: filter.filters.map((child) => normalizeCompositeFilter(child, rootDb)),
  };
}

export function unwrapCursorSnapshotForAdmin(
  snapshot: DocumentSnapshot,
  rootDb: SandboxFirestore,
): DocumentSnapshot {
  const unwrapped = adminToUnderlying.get(snapshot);
  if (unwrapped !== undefined) {
    return unwrapped as DocumentSnapshot;
  }
  return new Proxy(snapshot, {
    get(t, prop) {
      if (prop === 'ref') {
        return unwrapAdminObject(t.ref);
      }
      if (prop === 'data') {
        return () => {
          const data = t.data();
          if (data === undefined) {
            return undefined;
          }
          return unwrapQueryOperandReferences(data, rootDb) as DocumentData;
        };
      }
      if (prop === 'get') {
        return (fieldPath: SnapshotFieldPath) =>
          unwrapQueryOperandReferences(t.get(fieldPath), rootDb);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value === 'function') {
        return value.bind(t);
      }
      return value;
    },
  });
}

function validateSingleQueryValue(
  rawValue: unknown,
  directArrayElement: boolean,
  rootDb: SandboxFirestore,
): unknown {
  const validated = validateAndNormalizeFirestoreValue(rawValue, {
    arg: 'value',
    allowDeletes: 'none',
    allowTransforms: false,
    requireSentinelBrand: true,
    level: 0,
    pathLength: 0,
    inArray: directArrayElement,
    directArrayElement,
  });
  return unwrapQueryOperandReferences(validated, rootDb);
}

function validateDocumentIdBoundary(
  val: unknown,
  source: AdminQuerySource,
  rootDb: SandboxFirestore,
): unknown {
  if (typeof val === 'string') {
    if (source.kind === 'group') {
      const segments = val.split('/').filter((seg) => seg.length > 0);
      if (segments.length === 0 || segments.length % 2 !== 0) {
        throw new SandboxError(
          'invalid-argument',
          `When querying a collection group and ordering by FieldPath.documentId(), the corresponding value must result in a valid document path, but '${val}' is not because it contains an odd number of segments.`,
        );
      }
      return segments.join('/');
    }
    if (val.includes('/')) {
      throw new SandboxError(
        'invalid-argument',
        `When querying a collection and ordering by FieldPath.documentId(), the corresponding value must be a plain document ID, but '${val}' contains a slash.`,
      );
    }
    if (val.length === 0) {
      throw new SandboxError(
        'invalid-argument',
        `Only a direct child can be used as a query boundary. Found: "${source.path}".`,
      );
    }
    return val;
  }

  if (val !== null && typeof val === 'object') {
    const refPath = registeredAdminReferencePath(val);
    if (refPath !== undefined) {
      assertAdminDocumentReference('value', val);
      if (source.kind === 'collection') {
        const baseSegs = source.path.split('/');
        const refSegs = refPath.split('/');
        let hasPrefix = refSegs.length >= baseSegs.length;
        if (hasPrefix) {
          for (let i = 0; i < baseSegs.length; i += 1) {
            if (refSegs[i] !== baseSegs[i]) {
              hasPrefix = false;
              break;
            }
          }
        }
        if (!hasPrefix) {
          throw new SandboxError(
            'invalid-argument',
            `"${refPath}" is not part of the query result set and cannot be used as a query boundary.`,
          );
        }
        if (refSegs.length !== baseSegs.length + 1) {
          throw new SandboxError(
            'invalid-argument',
            `Only a direct child can be used as a query boundary. Found: "${refPath}".`,
          );
        }
      }
      return unwrapAdminObject(val);
    }
  }

  throw new SandboxError(
    'invalid-argument',
    `The corresponding value for FieldPath.documentId() must be a string or a DocumentReference, but was "${String(val)}".`,
  );
}

export function resolveDocumentIdCursorString(
  val: unknown,
  source: AdminQuerySource,
  rootDb: SandboxFirestore,
): string {
  const validated = validateDocumentIdBoundary(val, source, rootDb);
  if (typeof validated === 'string') {
    return validated;
  }
  const refPath =
    val !== null && typeof val === 'object' ? registeredAdminReferencePath(val) : undefined;
  if (refPath === undefined) {
    throw new SandboxError(
      'invalid-argument',
      `The corresponding value for FieldPath.documentId() must be a string or a DocumentReference, but was "${String(val)}".`,
    );
  }
  if (source.kind === 'group') {
    return refPath;
  }
  const refSegs = refPath.split('/');
  return refSegs[refSegs.length - 1] ?? refPath;
}

export function serializeCursorOperandForSignature(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'num:NaN';
    return `num:${String(value)}`;
  }
  if (typeof value === 'string') return `str:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `bool:${String(value)}`;
  if (typeof value !== 'object') return `prim:${String(value)}`;
  const refPath = registeredAdminReferencePath(value);
  if (refPath !== undefined) return `ref:${refPath}`;
  if (isAdminGeoPoint(value)) {
    return `geo:${String(value.latitude)},${String(value.longitude)}`;
  }
  if (isAdminVectorValue(value)) {
    return `vec:${JSON.stringify(value.toArray())}`;
  }
  if (value instanceof Uint8Array) {
    return `bytes:${Array.from(value).join(',')}`;
  }
  const tsCandidate = value as { seconds?: unknown; nanoseconds?: unknown; toMillis?: unknown };
  if (
    typeof tsCandidate.seconds === 'number' &&
    typeof tsCandidate.nanoseconds === 'number' &&
    typeof tsCandidate.toMillis === 'function'
  ) {
    return `ts:${String(tsCandidate.seconds)}:${String(tsCandidate.nanoseconds)}`;
  }
  if (Array.isArray(value)) {
    return `arr:[${value.map(serializeCursorOperandForSignature).join(',')}]`;
  }
  if (isPlainMap(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${serializeCursorOperandForSignature(value[k])}`);
    return `map:{${entries.join(',')}}`;
  }
  return `obj:${JSON.stringify(value)}`;
}

export function validateAndNormalizeWhereArgs(
  field: unknown,
  rawOp: unknown,
  rawValue: unknown,
  meta: AdminQueryMetadata,
  rootDb: SandboxFirestore,
): { field: SnapshotFieldPath; op: WhereFilterOp; value: unknown } {
  const fieldSegs = validateStringOrFieldPath('fieldPath', field);

  let normalizedOp = rawOp;
  if (normalizedOp === '=') {
    normalizedOp = '==';
  }
  if (typeof normalizedOp !== 'string' || !VALID_WHERE_OPERATORS.has(normalizedOp)) {
    throw new SandboxError('invalid-argument', 'Value for argument "opStr" is invalid.');
  }
  const op = normalizedOp as WhereFilterOp;

  if (typeof rawValue === 'number' && Number.isNaN(rawValue) && op !== '==' && op !== '!=') {
    throw new SandboxError(
      'invalid-argument',
      "Invalid query. You can only perform '==' and '!=' comparisons on NaN.",
    );
  }
  if (rawValue === null && op !== '==' && op !== '!=') {
    throw new SandboxError(
      'invalid-argument',
      "Invalid query. You can only perform '==' and '!=' comparisons on Null.",
    );
  }

  const isDocIdField = fieldSegs.length === 1 && fieldSegs[0] === '__name__';
  if (isDocIdField) {
    // Validate base query value constraints first (rejecting undefined, transforms, etc.)
    validateAndNormalizeFirestoreValue(rawValue, {
      arg: 'value',
      allowDeletes: 'none',
      allowTransforms: false,
      requireSentinelBrand: true,
      level: 0,
      pathLength: 0,
      inArray: false,
      directArrayElement: false,
    });

    if (op === 'array-contains' || op === 'array-contains-any') {
      throw new SandboxError(
        'invalid-argument',
        `Invalid Query. You can't perform '${op}' queries on FieldPath.documentId().`,
      );
    }
    if (op === 'in' || op === 'not-in') {
      if (!Array.isArray(rawValue) || rawValue.length === 0) {
        throw new SandboxError(
          'invalid-argument',
          `Invalid Query. A non-empty array is required for '${op}' filters.`,
        );
      }
      const maxLen = op === 'not-in' ? 10 : 30;
      if (rawValue.length > maxLen) {
        throw new SandboxError(
          'invalid-argument',
          `'${op}' filters support a maximum of ${maxLen} elements.`,
        );
      }
      const mapped = rawValue.map((entry) =>
        validateDocumentIdBoundary(entry, meta.source, rootDb),
      );
      return { field: FieldPath.documentId(), op, value: mapped };
    }
    const singleBoundary = validateDocumentIdBoundary(rawValue, meta.source, rootDb);
    return { field: FieldPath.documentId(), op, value: singleBoundary };
  }

  const normalizedField = toNormalizedQueryField(field, fieldSegs);

  if (op === 'in' || op === 'not-in') {
    // Validate top-level container first so non-serializable/undefined values fail cleanly
    if (!Array.isArray(rawValue)) {
      validateSingleQueryValue(rawValue, false, rootDb);
      throw new SandboxError(
        'invalid-argument',
        `Invalid Query. A non-empty array is required for '${op}' filters.`,
      );
    }
    const maxLen = op === 'not-in' ? 10 : 30;
    const normalizedItems = rawValue.map((entry) =>
      validateSingleQueryValue(entry, false, rootDb),
    );
    if (normalizedItems.length === 0 || normalizedItems.length > maxLen) {
      throw new SandboxError(
        'invalid-argument',
        `'${op}' filters require between 1 and ${maxLen} comparison values.`,
      );
    }
    return { field: normalizedField, op, value: normalizedItems };
  }

  if (op === 'array-contains-any') {
    if (!Array.isArray(rawValue)) {
      validateSingleQueryValue(rawValue, false, rootDb);
      throw new SandboxError(
        'invalid-argument',
        "Invalid Query. A non-empty array is required for 'array-contains-any' filters.",
      );
    }
    const normalizedItems = rawValue.map((entry) =>
      validateSingleQueryValue(entry, true, rootDb),
    );
    if (normalizedItems.length === 0 || normalizedItems.length > 30) {
      throw new SandboxError(
        'invalid-argument',
        "'array-contains-any' filters require between 1 and 30 comparison values.",
      );
    }
    return { field: normalizedField, op, value: normalizedItems };
  }

  if (op === 'array-contains') {
    const normalizedItem = validateSingleQueryValue(rawValue, true, rootDb);
    return { field: normalizedField, op, value: normalizedItem };
  }

  const normalizedScalar = validateSingleQueryValue(rawValue, false, rootDb);
  return { field: normalizedField, op, value: normalizedScalar };
}

export function validateAndNormalizeOrderByArgs(
  field: unknown,
  directionStr: unknown,
): { field: SnapshotFieldPath; segments: readonly string[]; direction: OrderDirection } {
  const fieldSegs = validateStringOrFieldPath('fieldPath', field);
  const normalizedField = toNormalizedQueryField(field, fieldSegs);

  if (directionStr === undefined) {
    return { field: normalizedField, segments: fieldSegs, direction: 'asc' };
  }
  if (typeof directionStr === 'string') {
    const lower = directionStr.toLowerCase();
    if (lower === 'asc' || lower === 'desc') {
      return { field: normalizedField, segments: fieldSegs, direction: lower };
    }
  }
  throw new SandboxError(
    'invalid-argument',
    'Value for argument "directionStr" is invalid. Acceptable values are: asc, desc',
  );
}

export function validateAdminLimitInteger(argName: 'limit' | 'limitToLast', value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isInteger(value)) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid integer.`,
    );
  }
  if (value <= 0) {
    throw new SandboxError(
      'invalid-argument',
      `Value for argument "${argName}" is not a valid positive integer limit.`,
    );
  }
  return value;
}

export function assertQueryExecutable(meta: AdminQueryMetadata | undefined): void {
  if (meta === undefined) {
    return;
  }
  if (meta.pendingLimitType === 'last' && !meta.hasExplicitOrderBy) {
    throw new SandboxError(
      'invalid-argument',
      'limitToLast() queries require specifying at least one orderBy() clause.',
    );
  }
}
