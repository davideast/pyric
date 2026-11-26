/**
 * Item 2 — FieldValue sentinel converters.
 *
 * Four converters resolve the Firestore FieldValue sentinels at the
 * write boundary, alongside the Date/serverTimestamp converters from
 * Item 1:
 *
 *   - `increment`     — `{ __type:'increment', value:n }` → prior + n
 *   - `arrayUnion`    — `{ __type:'arrayUnion', values:[…] }` →
 *                       prior array with new values appended (deduped)
 *   - `arrayRemove`   — `{ __type:'arrayRemove', values:[…] }` →
 *                       prior array with listed values removed
 *   - `deleteField`   — `{ __type:'deleteField' }` → {@link DELETE_MARKER}
 *                       sentinel symbol; the resolver hands it to the
 *                       write layer which partitions it out (see
 *                       {@link partitionDeletes} in value-resolver.ts)
 *
 * Sentinel shape:
 *   Plain `{ __type: '<name>', ... }` objects mirror the existing
 *   serverTimestamp convention so producers (admin SDK shim, agent
 *   tools, seeded literals) all use one shape. The exported
 *   `INCREMENT()`, `ARRAY_UNION()`, `ARRAY_REMOVE()`, `DELETE_FIELD`
 *   helpers are the canonical constructors.
 *
 * Prior lookup:
 *   `ctx.fieldSegments` and `ctx.prior` together identify what value to
 *   read from the existing doc. {@link readPrior} walks the literal
 *   segments, returning `undefined` for any missing segment.
 *
 * Idempotency:
 *   Each converter only claims its own sentinel shape. The output —
 *   a number, an array, or {@link DELETE_MARKER} — is not a sentinel,
 *   so the second resolver pass is a no-op. The Item 0 contract
 *   verifies this.
 *
 * Type mismatch (FS-B11):
 *   Firestore OVERWRITES a mismatched prior rather than erroring —
 *   `increment(n)` on a non-number uses a base value of 0 (result `n`);
 *   `arrayUnion`/`arrayRemove` on a non-array coerce the base to `[]`.
 *   Mirrors `clones/.../model/transform_operation.ts`
 *   (`computeTransformOperationBaseValue`, `coercedFieldValuesArray`).
 */
import { INT64_MAX, INT64_MIN, isHostIntNumber } from '@pyric/rules/internal';
import {
  KEEP,
  DELETE_MARKER,
  resolveValue,
  type ValueConverter,
  type ResolveContext,
} from '../value-resolver.js';
import { isPlainObject } from '../../plain-object.js';
import { compareNumericValues } from '../query-value-order.js';
import { registeredReferenceQueryValue } from '../query-value-registry.js';
import { isUnescapedUserMap, markFieldValueSentinel } from '../unescaped-map.js';
import { firestoreValuesEqual } from '../value-equality.js';

// ═══ Sentinel shapes ═══

interface IncrementSentinel { __type: 'increment'; value: number }
interface MaximumSentinel { __type: 'maximum'; value: number }
interface MinimumSentinel { __type: 'minimum'; value: number }
interface ArrayUnionSentinel { __type: 'arrayUnion'; values: unknown[] }
interface ArrayRemoveSentinel { __type: 'arrayRemove'; values: unknown[] }
interface DeleteFieldSentinel { __type: 'deleteField' }

function isIncrement(v: unknown): v is IncrementSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'increment'
    && typeof (v as Record<string, unknown>).value === 'number';
}
function isMaximum(v: unknown): v is MaximumSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'maximum'
    && typeof (v as Record<string, unknown>).value === 'number';
}
function isMinimum(v: unknown): v is MinimumSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'minimum'
    && typeof (v as Record<string, unknown>).value === 'number';
}
function isArrayUnion(v: unknown): v is ArrayUnionSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'arrayUnion'
    && Array.isArray((v as Record<string, unknown>).values);
}
function isArrayRemove(v: unknown): v is ArrayRemoveSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'arrayRemove'
    && Array.isArray((v as Record<string, unknown>).values);
}
function isDeleteField(v: unknown): v is DeleteFieldSentinel {
  return typeof v === 'object' && v !== null
    && !isUnescapedUserMap(v)
    && (v as Record<string, unknown>).__type === 'deleteField';
}

// ═══ Sentinel constructors (canonical producers) ═══

export function INCREMENT(value: number): IncrementSentinel {
  return markFieldValueSentinel({ __type: 'increment', value });
}
export function MAXIMUM(value: number): MaximumSentinel {
  return markFieldValueSentinel({ __type: 'maximum', value });
}
export function MINIMUM(value: number): MinimumSentinel {
  return markFieldValueSentinel({ __type: 'minimum', value });
}
export function ARRAY_UNION(...values: unknown[]): ArrayUnionSentinel {
  return markFieldValueSentinel({ __type: 'arrayUnion', values });
}
export function ARRAY_REMOVE(...values: unknown[]): ArrayRemoveSentinel {
  return markFieldValueSentinel({ __type: 'arrayRemove', values });
}
export const DELETE_FIELD: DeleteFieldSentinel = markFieldValueSentinel({ __type: 'deleteField' });

// ═══ Prior lookup ═══

/**
 * Read the prior value at `ctx.fieldSegments` (field names, then array
 * indices as numbers; a field name may contain `.`). Returns `undefined`
 * for any missing segment so callers
 * can apply "missing prior" defaults (e.g., increment treats absent
 * as 0; arrayUnion treats absent as []).
 */
function readPrior(ctx: ResolveContext): unknown {
  if (ctx.prior === null) return undefined;
  let cursor: unknown = ctx.prior;
  for (const segment of ctx.fieldSegments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
      continue;
    }
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

// ═══ Converters ═══

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function clampInt64(value: bigint): bigint {
  if (value > INT64_MAX) return INT64_MAX;
  if (value < INT64_MIN) return INT64_MIN;
  return value;
}

function normalizeInt64(value: bigint): number | bigint {
  const clamped = clampInt64(value);
  if (clamped >= MIN_SAFE_BIGINT && clamped <= MAX_SAFE_BIGINT) {
    return Number(clamped);
  }
  return clamped;
}

function applyNumericIncrement(prior: unknown, delta: number): number | bigint {
  if (typeof prior === 'bigint') {
    if (isHostIntNumber(delta)) {
      return normalizeInt64(prior + BigInt(delta));
    }
    return Number(prior) + delta;
  }
  if (typeof prior === 'number') {
    if (isHostIntNumber(prior) && isHostIntNumber(delta)) {
      return normalizeInt64(BigInt(prior) + BigInt(delta));
    }
    return prior + delta;
  }
  // FS-B11: Firestore overwrites a missing or non-numeric prior with the
  // operand itself (preserving -0, NaN, and infinities as floats).
  return delta;
}

export const incrementConverter: ValueConverter = {
  name: 'increment-sentinel',
  convert(value, ctx) {
    if (!isIncrement(value)) return KEEP;
    const prior = readPrior(ctx);
    return applyNumericIncrement(prior, value.value);
  },
};

function applyNumericMaximum(prior: unknown, operand: number): number | bigint {
  if (typeof prior !== 'number' && typeof prior !== 'bigint') {
    return operand;
  }
  if (Number.isNaN(operand)) {
    return Number.NaN;
  }
  if (typeof prior === 'number' && Number.isNaN(prior)) {
    return Number.NaN;
  }
  if (compareNumericValues(operand, prior) > 0) {
    return operand;
  }
  return prior;
}

function applyNumericMinimum(prior: unknown, operand: number): number | bigint {
  if (typeof prior !== 'number' && typeof prior !== 'bigint') {
    return operand;
  }
  if (Number.isNaN(operand)) {
    return Number.NaN;
  }
  if (typeof prior === 'number' && Number.isNaN(prior)) {
    return Number.NaN;
  }
  if (compareNumericValues(operand, prior) < 0) {
    return operand;
  }
  return prior;
}

export const maximumConverter: ValueConverter = {
  name: 'maximum-sentinel',
  convert(value, ctx) {
    if (!isMaximum(value)) return KEEP;
    if (ctx.fieldSegments.some((segment) => typeof segment === 'number')) {
      throw new Error('maximum() is not currently supported inside arrays');
    }
    const prior = readPrior(ctx);
    return applyNumericMaximum(prior, value.value);
  },
};

export const minimumConverter: ValueConverter = {
  name: 'minimum-sentinel',
  convert(value, ctx) {
    if (!isMinimum(value)) return KEEP;
    if (ctx.fieldSegments.some((segment) => typeof segment === 'number')) {
      throw new Error('minimum() is not currently supported inside arrays');
    }
    const prior = readPrior(ctx);
    return applyNumericMinimum(prior, value.value);
  },
};

function nestedFieldValueName(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || isUnescapedUserMap(v)) return null;
  if (isIncrement(v)) return 'increment()';
  if (isMaximum(v)) return 'maximum()';
  if (isMinimum(v)) return 'minimum()';
  if (isArrayUnion(v)) return 'arrayUnion()';
  if (isArrayRemove(v)) return 'arrayRemove()';
  if (isDeleteField(v)) return 'deleteField()';
  if ((v as Record<string, unknown>).__type === 'serverTimestamp') return 'serverTimestamp()';
  return null;
}

function assertNoNestedFieldValues(values: readonly unknown[], ownerName: string): void {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    const sentinelName = nestedFieldValueName(node);
    if (sentinelName !== null) {
      throw new Error(`${sentinelName} cannot be used inside of ${ownerName}`);
    }
    if (registeredReferenceQueryValue(node) !== undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const child of Object.values(node)) visit(child);
  };
  for (const item of values) visit(item);
}

function resolveArrayElements(values: readonly unknown[], ctx: ResolveContext): unknown[] {
  return values.map((item, index) =>
    resolveValue(item, {
      ...ctx,
      prior: null,
      fieldPath: `${ctx.fieldPath}[${index}]`,
      fieldSegments: [...ctx.fieldSegments, index],
    }),
  );
}

export const arrayUnionConverter: ValueConverter = {
  name: 'array-union-sentinel',
  convert(value, ctx) {
    if (!isArrayUnion(value)) return KEEP;
    assertNoNestedFieldValues(value.values, 'arrayUnion()');
    const resolvedValues = resolveArrayElements(value.values, ctx);
    const prior = readPrior(ctx);
    // FS-B11 — a non-array (or absent) prior is coerced to `[]` rather than
    // throwing (upstream `coercedFieldValuesArray`).
    const base: unknown[] = Array.isArray(prior) ? prior.slice() : [];
    for (const v of resolvedValues) {
      const exists = base.some((b) => firestoreValuesEqual(b, v));
      if (!exists) base.push(v);
    }
    return base;
  },
};

export const arrayRemoveConverter: ValueConverter = {
  name: 'array-remove-sentinel',
  convert(value, ctx) {
    if (!isArrayRemove(value)) return KEEP;
    assertNoNestedFieldValues(value.values, 'arrayRemove()');
    const resolvedValues = resolveArrayElements(value.values, ctx);
    const prior = readPrior(ctx);
    // FS-B11 — a non-array (or absent) prior coerces to `[]` (so the result
    // is `[]`), rather than throwing.
    if (!Array.isArray(prior)) return [];
    return prior.filter((b) => !resolvedValues.some((v) => firestoreValuesEqual(b, v)));
  },
};

export const deleteFieldConverter: ValueConverter = {
  name: 'delete-field-sentinel',
  convert(value) {
    if (!isDeleteField(value)) return KEEP;
    return DELETE_MARKER;
  },
};
