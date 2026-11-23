/**
 * Admin-SDK `Filter`, `AggregateField`, `AggregateQuery`, and cursor bound
 * (`startAt`, `startAfter`, `endAt`, `endBefore`) adapters across local and
 * JSON-wire remote sandboxes.
 */

import { defineDeferredMembers } from 'pyric/app/internal';
import {
  FieldPath as CompatFieldPath,
  type AggregateField as CompatAggregateField,
  type AggregateSpec,
  type DocumentSnapshot,
  type Filter as CompatFilter,
  type Query,
  type SnapshotFieldPath,
  type WhereFilterOp,
} from 'pyric/sandbox/admin-compat';
import { SandboxError } from 'pyric/sandbox';
import type { SandboxFirestore } from 'pyric/sandbox/admin-firestore';
import { adminDocSnapshotBrand, isAppBackedRoot, unwrapAdminObject } from './admin-handle-registry.js';
import {
  createAdminGrpcError,
  runWithAdminErrorsAsync,
  runWithAdminErrorsSync,
} from './admin-grpc-errors.js';
import {
  assertAdminRootDatabaseDeclared,
  isBoundToUndeclaredPlaceholderEnv,
} from './admin-named-databases.js';
import {
  assertQueryExecutable,
  normalizeLegacyQueryOperand,
  resolveDocumentIdCursorString,
  serializeCursorOperandForSignature,
  unwrapCursorSnapshotForAdmin,
  validateAndNormalizeWhereArgs,
  type AdminQueryMetadata,
} from './admin-query-validation.js';
import {
  computePostOffsetAggregates,
  sliceQueryDocsForOffsetAndLimit,
} from './admin-query-extensions.js';
import { isAdminQueryEqual } from './admin-reference-and-snapshot-equality.js';
import { nextAdminTimestamp } from './admin-write-result-preconditions.js';
import { compareFieldSegments } from './admin-set-and-precondition-validation.js';
import {
  isFieldPathInstance,
  isPlainDocumentObject,
  validateAndNormalizeFirestoreValue,
  validateStringOrFieldPath,
} from './admin-write-validation.js';

const ADMIN_FILTER_NODE = Symbol('pyric.admin.firestore.filterNode');
const ADMIN_AGGREGATE_SPEC = Symbol('pyric.admin.firestore.aggregateSpec');

type InternalFilterNode =
  | {
      readonly kind: 'where';
      readonly fieldPath: unknown;
      readonly opStr: unknown;
      readonly value: unknown;
    }
  | { readonly kind: 'and'; readonly filters: readonly Filter[] }
  | { readonly kind: 'or'; readonly filters: readonly Filter[] };

export class Filter {
  readonly [ADMIN_FILTER_NODE]: InternalFilterNode;

  private constructor(node: InternalFilterNode) {
    this[ADMIN_FILTER_NODE] = node;
  }

  static where(fieldPath: SnapshotFieldPath, opStr: WhereFilterOp, value: unknown): Filter {
    runWithAdminErrorsSync(true, () => validateStringOrFieldPath('fieldPath', fieldPath));
    return new Filter({ kind: 'where', fieldPath, opStr, value });
  }

  static or(...filters: Filter[]): Filter {
    for (const entry of filters) {
      if (!(entry instanceof Filter)) {
        throw createAdminGrpcError(
          3,
          'Function "Filter.or()" requires every argument to be a Filter.',
        );
      }
    }
    return new Filter({ kind: 'or', filters: [...filters] });
  }

  static and(...filters: Filter[]): Filter {
    for (const entry of filters) {
      if (!(entry instanceof Filter)) {
        throw createAdminGrpcError(
          3,
          'Function "Filter.and()" requires every argument to be a Filter.',
        );
      }
    }
    return new Filter({ kind: 'and', filters: [...filters] });
  }
}

export function isAdminFilterInstance(value: unknown): value is Filter {
  return value instanceof Filter;
}

export function compileAdminFilter(
  filter: Filter,
  meta: AdminQueryMetadata,
  rootDb: SandboxFirestore,
): CompatFilter | null {
  const node = filter[ADMIN_FILTER_NODE];
  if (node.kind === 'where') {
    const normalized = validateAndNormalizeWhereArgs(
      node.fieldPath,
      node.opStr,
      node.value,
      meta,
      rootDb,
    );
    return {
      kind: 'where',
      field: normalized.field,
      op: normalized.op,
      value: normalized.value,
    };
  }
  const compiledChildren: CompatFilter[] = [];
  for (const child of node.filters) {
    const compiled = compileAdminFilter(child, meta, rootDb);
    if (compiled !== null) {
      compiledChildren.push(compiled);
    }
  }
  if (compiledChildren.length === 0) {
    return null;
  }
  return {
    kind: node.kind,
    filters: compiledChildren,
  };
}

export class AggregateField {
  readonly type = 'AggregateField';
  readonly aggregateType: 'count' | 'sum' | 'avg';
  readonly [ADMIN_AGGREGATE_SPEC]: CompatAggregateField;
  private readonly segments: readonly string[] | undefined;

  private constructor(
    aggregateType: 'count' | 'sum' | 'avg',
    spec: CompatAggregateField,
    segments: readonly string[] | undefined,
  ) {
    this.aggregateType = aggregateType;
    this[ADMIN_AGGREGATE_SPEC] = spec;
    this.segments = segments;
  }

  static count(): AggregateField {
    return new AggregateField('count', { kind: 'count' }, undefined);
  }

  static sum(field: string | CompatFieldPath): AggregateField {
    const segments = runWithAdminErrorsSync(true, () => validateStringOrFieldPath('field', field));
    let normalizedField: string | CompatFieldPath = new CompatFieldPath(...segments);
    if (typeof field === 'string') {
      normalizedField = field;
    }
    return new AggregateField(
      'sum',
      { kind: 'sum', field: normalizedField, path: segments },
      segments,
    );
  }

  static average(field: string | CompatFieldPath): AggregateField {
    const segments = runWithAdminErrorsSync(true, () => validateStringOrFieldPath('field', field));
    let normalizedField: string | CompatFieldPath = new CompatFieldPath(...segments);
    if (typeof field === 'string') {
      normalizedField = field;
    }
    return new AggregateField(
      'avg',
      { kind: 'average', field: normalizedField, path: segments },
      segments,
    );
  }

  isEqual(other: unknown): boolean {
    if (!(other instanceof AggregateField)) {
      return false;
    }
    if (this.aggregateType !== other.aggregateType) {
      return false;
    }
    if (this.segments === undefined && other.segments === undefined) {
      return true;
    }
    if (this.segments === undefined || other.segments === undefined) {
      return false;
    }
    return compareFieldSegments(this.segments, other.segments) === 0;
  }
}

function normalizeSingleAggregateEntry(alias: string, rawEntry: unknown): CompatAggregateField {
  if (rawEntry instanceof AggregateField) {
    return rawEntry[ADMIN_AGGREGATE_SPEC];
  }
  if (isPlainDocumentObject(rawEntry)) {
    const rawKind = rawEntry.kind;
    if (rawKind === 'count') {
      return { kind: 'count' };
    }
    if (rawKind === 'sum' || rawKind === 'average') {
      const rawField = rawEntry.field;
      const segments = validateStringOrFieldPath(`aggregateSpec.${alias}`, rawField);
      let normalizedField: string | CompatFieldPath = new CompatFieldPath(...segments);
      if (typeof rawField === 'string' && !isFieldPathInstance(rawField)) {
        normalizedField = rawField;
      }
      return { kind: rawKind, field: normalizedField, path: segments };
    }
  }
  throw new SandboxError(
    'invalid-argument',
    `Value for argument "aggregateSpec.${alias}" is not a valid AggregateField.`,
  );
}

const adminAggregateSpecSignature = new WeakMap<object, string>();

function serializeAggregateSpec(spec: AggregateSpec): string {
  return Object.keys(spec)
    .sort()
    .map((alias) => {
      const entry = spec[alias];
      if (entry === undefined || entry.kind === 'count') {
        return `${JSON.stringify(alias)}:count`;
      }
      const fieldKey =
        entry.path !== undefined ? entry.path.join('.') : String(entry.field);
      return `${JSON.stringify(alias)}:${entry.kind}:${fieldKey}`;
    })
    .join('|');
}

export function buildAdminAggregateQuery(
  target: Query,
  receiverQuery: Query,
  rawDb: SandboxFirestore,
  rootDb: SandboxFirestore,
  rawSpec: unknown,
  meta: AdminQueryMetadata,
): Record<string, unknown> {
  const appBacked = isAppBackedRoot(rootDb);
  const normalizedSpec = runWithAdminErrorsSync(appBacked, () => {
    if (!isPlainDocumentObject(rawSpec)) {
      throw new SandboxError(
        'invalid-argument',
        'Value for argument "aggregateSpec" is not a plain JavaScript object.',
      );
    }
    const specOut: AggregateSpec = {};
    for (const alias of Object.keys(rawSpec)) {
      specOut[alias] = normalizeSingleAggregateEntry(alias, rawSpec[alias]);
    }
    return specOut;
  });
  const specSignature = serializeAggregateSpec(normalizedSpec);
  const aggQuery: Record<string, unknown> = {
    query: receiverQuery,
    get() {
      return runWithAdminErrorsAsync(appBacked, async () => {
        assertAdminRootDatabaseDeclared(rootDb);
        assertQueryExecutable(meta);
        if (meta.offsetCount !== undefined && meta.offsetCount < 0) {
          throw new SandboxError(
            'invalid-argument',
            'Value for argument "offset" must be non-negative.',
          );
        }
        const aliasCount = Object.keys(normalizedSpec).length;
        if (aliasCount < 1 || aliasCount > 5) {
          throw new SandboxError(
            'invalid-argument',
            'A minimum of one and maximum of five aggregations per query is required.',
          );
        }
        let liveTarget = target;
        if (isBoundToUndeclaredPlaceholderEnv(target)) {
          if (meta.replayOnRoot !== undefined) {
            liveTarget = unwrapAdminObject(meta.replayOnRoot(rootDb));
          } else if (meta.source.kind === 'collection') {
            liveTarget = rawDb.collection(meta.source.path);
          } else {
            liveTarget = rawDb.collectionGroup(meta.source.collectionId);
          }
        }
        let computed: Record<string, number | null>;
        const activeOffset = meta.offsetCount ?? 0;
        const allCountOnly = Object.values(normalizedSpec).every(
          (entry) => entry.kind === 'count',
        );
        if (activeOffset <= 0) {
          const rawSnap = await liveTarget.aggregate(normalizedSpec);
          computed = rawSnap.data();
        } else if (allCountOnly) {
          const rawSnap = await liveTarget.aggregate(normalizedSpec);
          const rawData = rawSnap.data();
          computed = {};
          for (const alias of Object.keys(normalizedSpec)) {
            const preOffsetCount = Number(rawData[alias] ?? 0);
            computed[alias] = Math.max(0, preOffsetCount - activeOffset);
          }
        } else {
          const snap = await liveTarget.get();
          const sliced = sliceQueryDocsForOffsetAndLimit(snap.docs, meta) ?? snap.docs;
          computed = computePostOffsetAggregates(sliced, normalizedSpec);
        }
        const readTime = nextAdminTimestamp(rawDb);
        return {
          query: receiverQuery,
          readTime,
          data: () => ({ ...computed }),
          isEqual(other: unknown): boolean {
            if (typeof other !== 'object' || other === null) {
              return false;
            }
            const otherCand = other as { query?: unknown; data?: unknown };
            if (!isAdminQueryEqual(receiverQuery, otherCand.query)) {
              return false;
            }
            if (typeof otherCand.data !== 'function') {
              return false;
            }
            const otherData = (otherCand.data as () => Record<string, unknown>).call(other);
            const keys = Object.keys(computed);
            if (keys.length !== Object.keys(otherData).length) {
              return false;
            }
            return keys.every((key) => Object.is(computed[key], otherData[key]));
          },
        };
      });
    },
    isEqual(other: unknown): boolean {
      if (other === aggQuery) {
        return true;
      }
      if (typeof other !== 'object' || other === null) {
        return false;
      }
      if (!adminAggregateSpecSignature.has(other)) {
        return false;
      }
      if (adminAggregateSpecSignature.get(other) !== specSignature) {
        return false;
      }
      return isAdminQueryEqual(receiverQuery, (other as { query?: unknown }).query);
    },
  };
  adminAggregateSpecSignature.set(aggQuery, specSignature);
  defineDeferredMembers(aggQuery, 'pyric-admin/firestore', 'AggregateQuery', {
    async: ['explain'],
  });
  return aggQuery;
}

function isCursorDocumentSnapshot(value: unknown): value is DocumentSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (adminDocSnapshotBrand.has(value)) {
    return true;
  }
  if (isPlainDocumentObject(value)) {
    return false;
  }
  const candidate = value as { data?: unknown; get?: unknown; exists?: unknown; id?: unknown };
  return (
    typeof candidate.data === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.exists === 'boolean' &&
    typeof candidate.id === 'string'
  );
}

export function applyAdminCursorArgs(
  target: Query,
  methodName: 'startAt' | 'startAfter' | 'endAt' | 'endBefore',
  args: readonly unknown[],
  meta: AdminQueryMetadata,
  rootDb: SandboxFirestore,
): { readonly nextTarget: Query; readonly cursorSignature: string } {
  if (args.length === 0) {
    throw new SandboxError(
      'invalid-argument',
      `Function "Query.${methodName}()" requires at least 1 argument.`,
    );
  }
  const inclusive = methodName === 'startAt' || methodName === 'endAt';
  const isStart = methodName === 'startAt' || methodName === 'startAfter';

  if (args.length === 1 && isCursorDocumentSnapshot(args[0])) {
    const snap = args[0];
    const unwrappedSnap = unwrapCursorSnapshotForAdmin(snap, rootDb);
    let nextTarget: Query;
    if (isStart) {
      nextTarget = target.startCursorFromSnapshot(unwrappedSnap, inclusive);
    } else {
      nextTarget = target.endCursorFromSnapshot(unwrappedSnap, inclusive);
    }
    const snapPath = typeof snap.ref?.path === 'string' ? snap.ref.path : snap.id;
    const cursorSignature = `snap:${String(inclusive)}:${snapPath}:${serializeCursorOperandForSignature(snap.data() ?? null)}`;
    return { nextTarget, cursorSignature };
  }

  if (args.length > meta.orderByFields.length) {
    throw new SandboxError(
      'invalid-argument',
      'Too many cursor values specified. The specified values must match the orderBy() constraints of the query.',
    );
  }

  const signatureParts: string[] = [];
  const normalizedValues = args.map((entry, idx) => {
    const orderField = meta.orderByFields[idx];
    const isDocIdOrder =
      orderField !== undefined && orderField.length === 1 && orderField[0] === '__name__';
    if (isDocIdOrder) {
      const cursorStr = resolveDocumentIdCursorString(entry, meta.source, rootDb);
      signatureParts.push(`docId:${cursorStr}`);
      return cursorStr;
    }
    const validated = validateAndNormalizeFirestoreValue(entry, {
      arg: idx,
      allowDeletes: 'none',
      allowTransforms: false,
      requireSentinelBrand: true,
      level: 0,
      pathLength: 0,
      inArray: false,
      directArrayElement: false,
    });
    signatureParts.push(serializeCursorOperandForSignature(validated));
    return normalizeLegacyQueryOperand(validated, rootDb);
  });

  const cursorSignature = `vals:${String(inclusive)}:${signatureParts.join('|')}`;
  if (isStart) {
    return { nextTarget: target.startCursor(normalizedValues, inclusive), cursorSignature };
  }
  return { nextTarget: target.endCursor(normalizedValues, inclusive), cursorSignature };
}
