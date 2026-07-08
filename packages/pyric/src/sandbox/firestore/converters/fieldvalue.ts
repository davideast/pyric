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
 *   `ctx.fieldPath` and `ctx.prior` together identify what value to
 *   read from the existing doc. {@link readPrior} walks the dotted
 *   path with bracketed array indices ("tags[0]", "user.profile.name"),
 *   returning `undefined` for any missing segment.
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
import { KEEP, DELETE_MARKER, type ValueConverter, type ResolveContext } from '../value-resolver.js';
import { firestoreValuesEqual } from '../value-equality.js';

// ═══ Sentinel shapes ═══

interface IncrementSentinel { __type: 'increment'; value: number }
interface ArrayUnionSentinel { __type: 'arrayUnion'; values: unknown[] }
interface ArrayRemoveSentinel { __type: 'arrayRemove'; values: unknown[] }
interface DeleteFieldSentinel { __type: 'deleteField' }

function isIncrement(v: unknown): v is IncrementSentinel {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).__type === 'increment'
    && typeof (v as Record<string, unknown>).value === 'number';
}
function isArrayUnion(v: unknown): v is ArrayUnionSentinel {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).__type === 'arrayUnion'
    && Array.isArray((v as Record<string, unknown>).values);
}
function isArrayRemove(v: unknown): v is ArrayRemoveSentinel {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).__type === 'arrayRemove'
    && Array.isArray((v as Record<string, unknown>).values);
}
function isDeleteField(v: unknown): v is DeleteFieldSentinel {
  return typeof v === 'object' && v !== null
    && (v as Record<string, unknown>).__type === 'deleteField';
}

// ═══ Sentinel constructors (canonical producers) ═══

export function INCREMENT(value: number): IncrementSentinel {
  return { __type: 'increment', value };
}
export function ARRAY_UNION(...values: unknown[]): ArrayUnionSentinel {
  return { __type: 'arrayUnion', values };
}
export function ARRAY_REMOVE(...values: unknown[]): ArrayRemoveSentinel {
  return { __type: 'arrayRemove', values };
}
export const DELETE_FIELD: DeleteFieldSentinel = { __type: 'deleteField' };

// ═══ Prior lookup ═══

/**
 * Read `ctx.prior.<fieldPath>` where fieldPath uses dot+bracket
 * notation as set by value-resolver.ts (`users.profile.name`,
 * `tags[0]`). Returns `undefined` for any missing segment so callers
 * can apply "missing prior" defaults (e.g., increment treats absent
 * as 0; arrayUnion treats absent as []).
 */
function readPrior(ctx: ResolveContext): unknown {
  if (ctx.prior === null) return undefined;
  if (ctx.fieldPath === '') return ctx.prior;
  let cursor: unknown = ctx.prior;
  // Split on '.' but keep bracketed indices attached. Then for each
  // segment, peel any [n] suffixes after the dotted name.
  for (const segment of ctx.fieldPath.split('.')) {
    // segment may be like "tags[0][1]" — pull out the name first.
    const nameMatch = /^([^\[]*)/.exec(segment);
    const name = nameMatch ? nameMatch[1] : segment;
    if (name) {
      if (typeof cursor !== 'object' || cursor === null) return undefined;
      cursor = (cursor as Record<string, unknown>)[name];
    }
    // Then walk any bracket indices.
    const bracketRE = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = bracketRE.exec(segment)) !== null) {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[Number(m[1])];
    }
  }
  return cursor;
}

// ═══ Converters ═══

export const incrementConverter: ValueConverter = {
  name: 'increment-sentinel',
  convert(value, ctx) {
    if (!isIncrement(value)) return KEEP;
    const prior = readPrior(ctx);
    // FS-B11 — Firestore OVERWRITES a mismatched prior rather than throwing:
    // `increment(n)` on a non-numeric (or absent) prior uses a base value of
    // 0, so the result is just `n`. Mirrors
    // `clones/.../model/transform_operation.ts`
    // `computeTransformOperationBaseValue` (`isNumber(prev) ? prev : 0`).
    const base = typeof prior === 'number' ? prior : 0;
    return base + value.value;
  },
};

export const arrayUnionConverter: ValueConverter = {
  name: 'array-union-sentinel',
  convert(value, ctx) {
    if (!isArrayUnion(value)) return KEEP;
    const prior = readPrior(ctx);
    // FS-B11 — a non-array (or absent) prior is coerced to `[]` rather than
    // throwing (upstream `coercedFieldValuesArray`).
    const base: unknown[] = Array.isArray(prior) ? prior.slice() : [];
    for (const v of value.values) {
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
    const prior = readPrior(ctx);
    // FS-B11 — a non-array (or absent) prior coerces to `[]` (so the result
    // is `[]`), rather than throwing.
    if (!Array.isArray(prior)) return [];
    return prior.filter((b) => !value.values.some((v) => firestoreValuesEqual(b, v)));
  },
};

export const deleteFieldConverter: ValueConverter = {
  name: 'delete-field-sentinel',
  convert(value) {
    if (!isDeleteField(value)) return KEEP;
    return DELETE_MARKER;
  },
};
