/**
 * Pure-data schema merge / inference for `firestore_discover_paths`.
 *
 * Validation-grade implementation promoted to production with the following
 * additions:
 *
 *   1. Enum-candidate tracking on string/integer/double scalar fields
 *      (Phase 3.2 lock — drives <select> codegen and discriminated unions).
 *   2. Per-field example value (Phase 3.2 lock — drives form placeholders,
 *      fixtures, README payloads).
 *   3. `null` is never a peer entry in `types[]`; only `nullable` carries the
 *      annotation (Phase 2.1 lock — suppresses redundant `type_expanded`
 *      events for null observations).
 *   4. SchemaChange enum aligned with the Phase 5 frozen list (`field_added`
 *      replaces `new_key`; `array_grew` and `presence_dropped` removed —
 *      array element growth surfaces as `type_expanded` with `'[]'` path
 *      segment; presence shifts surface as `presence_changed`).
 *
 * Pure functions only — no Firestore SDK imports. Wire-format conversion
 * lives in `wire.ts`; this module operates on already-typed observations.
 */

import type {
  FieldDescriptor,
  FieldPath,
  FieldSchema,
  FieldType,
  FirestoreScalarType,
  SchemaChange,
} from './types.js';

// ─── Constants ────────────────────────────────────────────────────────────

/** Default enum-candidate distinct-value cap (Phase 3.2 lock). */
export const DEFAULT_ENUM_THRESHOLD = 10;

// ─── Empty schema ─────────────────────────────────────────────────────────

export function emptySchema(): FieldSchema {
  return { fields: {}, samplesSeen: 0 };
}

// ─── Type key (for dedup; NaN-safe by construction) ───────────────────────

/**
 * Stable key for FieldType used in dedup. NaN/±Infinity all collapse to
 * `s:double` so no special handling needed (Phase 1.2 lock).
 */
export function fieldTypeKey(t: FieldType): string {
  switch (t.kind) {
    case 'scalar':
      return `s:${t.type}`;
    case 'reference':
      return `r:${t.targetCollection}`;
    case 'vector':
      return `v:${t.dimension}`;
    case 'array': {
      const inner = t.elementTypes.map(fieldTypeKey).sort().join('|');
      return `a:[${inner}]`;
    }
    case 'map': {
      const keys = Object.keys(t.fields).sort().join(',');
      return `m:{${keys}}`;
    }
  }
}

function dedupTypes(types: FieldType[]): FieldType[] {
  const seen = new Map<string, FieldType>();
  for (const t of types) seen.set(fieldTypeKey(t), t);
  return Array.from(seen.values());
}

// ─── Enum candidate helpers ───────────────────────────────────────────────

/** True if a scalar field type is enum-eligible (string/int/double only). */
function isEnumEligibleScalar(t: FieldType): t is { kind: 'scalar'; type: FirestoreScalarType } {
  if (t.kind !== 'scalar') return false;
  return t.type === 'string' || t.type === 'integer' || t.type === 'double';
}

/**
 * Extract a hashable enum-value sample from a typed observation. Only
 * callable when `isEnumEligibleScalar(type)` is true; the actual value lives
 * on the observation, not the type.
 */
type EnumSample = string | number;

// ─── Example-value helpers ────────────────────────────────────────────────

/**
 * Captured example for a field. JSON-serializable shallow projection of
 * the wire-decoded value. Strict scalars only at the top level; map fields
 * project recursively but skip vector/reference/bytes (those are wire-typed,
 * not codegen-friendly placeholders).
 */
type ExampleValue =
  | string
  | number
  | boolean
  | null
  | ExampleValue[]
  | { [k: string]: ExampleValue };

// ─── Observation contract ─────────────────────────────────────────────────

/**
 * A single field observation passed into `mergeDoc`. The wire layer
 * (`wire.ts`) is responsible for producing this shape.
 */
export interface FieldObservation {
  /** The inferred FieldType for this observation. `null` is allowed and is
   *  surfaced via `isNull`; the `type` itself is `{kind:'scalar', type:'null'}`
   *  by convention but is NOT added to the descriptor's types[] union. */
  type: FieldType;
  /** True iff the wire value was a null literal. */
  isNull: boolean;
  /** A JSON-safe sample of the wire value. Used to populate `example` on
   *  the descriptor when no example exists yet. Optional — wire layer omits
   *  for kinds with no codegen-friendly representation. */
  example?: ExampleValue;
  /** For enum-eligible scalars (string/int/double), the raw value. Used
   *  to update enumCandidate. */
  enumSample?: EnumSample;
}

// ─── Per-field merge ──────────────────────────────────────────────────────

interface MergeFieldResult {
  merged: FieldDescriptor;
  changes: SchemaChange[];
}

/**
 * Merge a single field observation into an existing descriptor.
 * `observation === 'absent'` means the field was missing from the doc.
 * `newTotal` is the doc count after this observation.
 */
export function mergeDescriptorWithObservation(
  prev: FieldDescriptor,
  observation: FieldObservation | 'absent',
  newTotal: number,
  path: FieldPath,
): MergeFieldResult {
  if (observation === 'absent') {
    // Field absent — bump total only. presence_changed is NOT emitted on
    // every absence (would be noisy); callers fold presence into a separate
    // sweep at finalization if needed.
    return { merged: { ...prev, presenceTotal: newTotal }, changes: [] };
  }

  const { type: obs, isNull, example, enumSample } = observation;
  const changes: SchemaChange[] = [];

  // Null observation: bump nullable + presenceSeen. Do NOT add `null` to
  // types[] (Phase 2.1 lock). Emit `became_nullable` once, on the transition.
  if (isNull) {
    const becameNullable = !prev.nullable;
    return {
      merged: {
        ...prev,
        presenceSeen: prev.presenceSeen + 1,
        presenceTotal: newTotal,
        nullable: true,
      },
      changes: becameNullable ? [{ kind: 'became_nullable', path }] : [],
    };
  }

  // Type union management (non-null observation).
  //
  // Container collapse rule: array and map kinds are SINGLETONS in the
  // descriptor's types[] union — at most one array entry, at most one map
  // entry. Element-type / field growth across observations merges into the
  // existing container entry rather than creating a parallel union member.
  // This is the Phase 5 lock: dropping `array_grew` in favor of
  // `type_expanded` at `[..., '[]']` presumes arrays collapse this way.
  // Vectors are NOT singletons — distinct dimensions stay distinct per
  // Phase 1.2 vector-drift lock.
  let mergedTypes = prev.types;

  if (obs.kind === 'array') {
    const existingIdx = prev.types.findIndex((t) => t.kind === 'array');
    if (existingIdx !== -1) {
      const existing = prev.types[existingIdx]!;
      if (existing.kind === 'array') {
        const result = mergeArrays(existing, obs, path);
        const next = [...prev.types];
        next[existingIdx] = result.merged;
        mergedTypes = next;
        changes.push(...result.changes);
      }
    } else {
      mergedTypes = [...prev.types, obs];
      changes.push({ kind: 'type_expanded', path, addedType: obs });
    }
  } else if (obs.kind === 'map') {
    const existingIdx = prev.types.findIndex((t) => t.kind === 'map');
    if (existingIdx !== -1) {
      const existing = prev.types[existingIdx]!;
      if (existing.kind === 'map') {
        const result = mergeMaps(existing, obs, path);
        const next = [...prev.types];
        next[existingIdx] = result.merged;
        mergedTypes = next;
        changes.push(...result.changes);
      }
    } else {
      mergedTypes = [...prev.types, obs];
      changes.push({ kind: 'type_expanded', path, addedType: obs });
    }
  } else {
    // Scalar / reference / vector union management. Vectors stay distinct
    // per dimension (different keys for different dims) — that's the lock.
    const obsKey = fieldTypeKey(obs);
    const prevKeys = new Set(prev.types.map(fieldTypeKey));
    if (!prevKeys.has(obsKey)) {
      mergedTypes = dedupTypes([...prev.types, obs]);
      if (obs.kind === 'vector' && prev.types.some((t) => t.kind === 'vector')) {
        changes.push({
          kind: 'vector_dim_drift',
          path,
          addedDimension: obs.dimension as number,
        });
      } else {
        changes.push({ kind: 'type_expanded', path, addedType: obs });
      }
    }
  }

  // Enum candidate update. Drop if the type union widened past enum
  // eligibility (more than one type, or non-eligible type added).
  let enumCandidate = prev.enumCandidate;
  const stillEnumEligible =
    mergedTypes.length === 1 && isEnumEligibleScalar(mergedTypes[0]!);
  if (!stillEnumEligible && enumCandidate) {
    changes.push({ kind: 'enum_dropped', path, reason: 'type_widened' });
    enumCandidate = undefined;
  } else if (stillEnumEligible && enumSample !== undefined) {
    const result = updateEnumCandidate(enumCandidate, enumSample, path);
    enumCandidate = result.next;
    changes.push(...result.changes);
  }

  // Example: capture on first non-null observation. Don't overwrite once set
  // (deterministic for codegen).
  const nextExample =
    prev.example === undefined && example !== undefined ? example : prev.example;

  return {
    merged: {
      types: mergedTypes,
      presenceSeen: prev.presenceSeen + 1,
      presenceTotal: newTotal,
      nullable: prev.nullable,
      enumCandidate,
      example: nextExample,
      reservedReason: prev.reservedReason,
    },
    changes,
  };
}

// ─── Enum candidate state machine ─────────────────────────────────────────

/**
 * Progress an enum candidate by one observation. State transitions:
 *
 *   undefined     + new sample → tracking (1 value, no event)
 *   tracking(1)   + same       → tracking (no event)
 *   tracking(1)   + new        → tracking (2 values), emit `enum_added`
 *   tracking(N>1) + new (N+1<=threshold) → tracking, emit `enum_widened`
 *   tracking(N=threshold) + new → undefined, emit `enum_dropped(over_threshold)`
 */
function updateEnumCandidate(
  prev: FieldDescriptor['enumCandidate'],
  sample: EnumSample,
  path: FieldPath,
): { next: FieldDescriptor['enumCandidate']; changes: SchemaChange[] } {
  if (prev === undefined) {
    // First sighting — start tracking silently. Single value isn't an enum yet.
    return {
      next: { qualifies: false, values: [sample], threshold: DEFAULT_ENUM_THRESHOLD },
      changes: [],
    };
  }
  if (prev.values.includes(sample)) {
    return { next: prev, changes: [] };
  }
  // New value — does it fit?
  if (prev.values.length >= prev.threshold) {
    return {
      next: undefined,
      changes: [{ kind: 'enum_dropped', path, reason: 'over_threshold' }],
    };
  }
  const nextValues = [...prev.values, sample];
  const wasFirstAdd = prev.values.length === 1;
  // Mark qualifies once we have 2+ distinct values (still under threshold).
  const next = { qualifies: true, values: nextValues, threshold: prev.threshold };
  if (wasFirstAdd) {
    return {
      next,
      changes: [{ kind: 'enum_added', path, values: nextValues }],
    };
  }
  return {
    next,
    changes: [{ kind: 'enum_widened', path, addedValue: sample }],
  };
}

// ─── Container-type recursive merges ──────────────────────────────────────

function mergeArrays(
  prev: { kind: 'array'; elementTypes: FieldType[] },
  obs: { kind: 'array'; elementTypes: FieldType[] },
  path: FieldPath,
): { merged: FieldType; changes: SchemaChange[] } {
  // Empty array no-op merge (Phase 1.2 lock).
  if (obs.elementTypes.length === 0) return { merged: prev, changes: [] };
  if (prev.elementTypes.length === 0) {
    return { merged: { kind: 'array', elementTypes: obs.elementTypes }, changes: [] };
  }
  const prevKeys = new Set(prev.elementTypes.map(fieldTypeKey));
  const changes: SchemaChange[] = [];
  const merged = [...prev.elementTypes];
  const elementPath: FieldPath = [...path, '[]'];
  for (const et of obs.elementTypes) {
    if (!prevKeys.has(fieldTypeKey(et))) {
      merged.push(et);
      // Array element-type expansion surfaces as `type_expanded` at the
      // `[]` path segment per Phase 5 SchemaChange enum.
      changes.push({ kind: 'type_expanded', path: elementPath, addedType: et });
    }
  }
  return { merged: { kind: 'array', elementTypes: dedupTypes(merged) }, changes };
}

function mergeMaps(
  prev: { kind: 'map'; fields: Record<string, FieldDescriptor> },
  obs: { kind: 'map'; fields: Record<string, FieldDescriptor> },
  path: FieldPath,
): { merged: FieldType; changes: SchemaChange[] } {
  // Empty map no-op merge (Phase 1.2 lock).
  if (Object.keys(obs.fields).length === 0) return { merged: prev, changes: [] };
  if (Object.keys(prev.fields).length === 0) {
    return { merged: { kind: 'map', fields: { ...obs.fields } }, changes: [] };
  }
  const changes: SchemaChange[] = [];
  const fields: Record<string, FieldDescriptor> = { ...prev.fields };
  for (const [k, obsDesc] of Object.entries(obs.fields)) {
    const prevDesc = fields[k];
    if (!prevDesc) {
      fields[k] = obsDesc;
      changes.push({ kind: 'field_added', path: [...path, k], type: obsDesc.types[0]! });
      continue;
    }
    // Recurse on the single observed type.
    const obsType = obsDesc.types[0]!;
    const isNull = obsDesc.nullable && obsDesc.types.length === 0;
    const subResult = mergeDescriptorWithObservation(
      prevDesc,
      {
        type: obsType ?? { kind: 'scalar', type: 'null' },
        isNull,
        example: obsDesc.example,
        enumSample: extractEnumSample(obsType, obsDesc.example),
      },
      prevDesc.presenceTotal + 1,
      [...path, k],
    );
    fields[k] = subResult.merged;
    changes.push(...subResult.changes);
  }
  return { merged: { kind: 'map', fields }, changes };
}

/** Best-effort extraction of an enum sample from a nested-map observation. */
function extractEnumSample(
  type: FieldType | undefined,
  example: ExampleValue | undefined,
): EnumSample | undefined {
  if (!type || !isEnumEligibleScalar(type)) return undefined;
  if (typeof example === 'string' || typeof example === 'number') return example;
  return undefined;
}

// ─── Top-level mergeDoc ───────────────────────────────────────────────────

/**
 * Merge a single document's typed field observations into a collection-level
 * schema. Returns the next schema and the changes emitted.
 *
 * The wire layer (`wire.ts`) is responsible for converting Firestore wire
 * values into the `Record<string, FieldObservation>` shape expected here.
 */
export function mergeDoc(
  prev: FieldSchema,
  doc: Record<string, FieldObservation>,
): { next: FieldSchema; changes: SchemaChange[] } {
  const newTotal = prev.samplesSeen + 1;
  const allKeys = new Set([...Object.keys(prev.fields), ...Object.keys(doc)]);
  const fields: Record<string, FieldDescriptor> = {};
  const changes: SchemaChange[] = [];

  for (const k of allKeys) {
    const prevDesc = prev.fields[k];
    const obs = doc[k];

    if (!prevDesc && obs) {
      // First time seeing this key.
      const isNull = obs.isNull;
      const enumEligible = !isNull && isEnumEligibleScalar(obs.type);
      const enumCandidate =
        enumEligible && obs.enumSample !== undefined
          ? {
              qualifies: false,
              values: [obs.enumSample],
              threshold: DEFAULT_ENUM_THRESHOLD,
            }
          : undefined;
      fields[k] = {
        types: isNull ? [] : [obs.type],
        presenceSeen: 1,
        presenceTotal: newTotal,
        nullable: isNull,
        enumCandidate,
        example: obs.example,
      };
      if (!isNull) {
        changes.push({ kind: 'field_added', path: [k], type: obs.type });
      } else {
        // Null-only first observation: emit field_added with null kind so
        // agents see the field surfaced; nullable annotation handles the
        // rest. No became_nullable on first observation — there's no prior
        // non-null state to flip from.
        changes.push({
          kind: 'field_added',
          path: [k],
          type: { kind: 'scalar', type: 'null' },
        });
      }
      continue;
    }

    if (prevDesc && !obs) {
      const result = mergeDescriptorWithObservation(prevDesc, 'absent', newTotal, [k]);
      fields[k] = result.merged;
      changes.push(...result.changes);
      continue;
    }

    if (prevDesc && obs) {
      const result = mergeDescriptorWithObservation(prevDesc, obs, newTotal, [k]);
      fields[k] = result.merged;
      changes.push(...result.changes);
    }
  }

  return { next: { fields, samplesSeen: newTotal }, changes };
}

// ─── Convergence runner ───────────────────────────────────────────────────

export interface ConvergenceResult {
  /** Doc index where `stopOnStable` fired (0-based), or null if never. */
  declaredAt: number | null;
  /** Total docs consumed (≤ stream length). */
  totalDocs: number;
  /** Total change count across the stream. */
  totalChanges: number;
  /** Final accumulated schema. */
  finalSchema: FieldSchema;
  /** Changes emitted *after* convergence was declared — caller-visible
   *  for test-time assertion that `stopOnStable` would not have lost data. */
  missedChangesAfterDeclared: SchemaChange[];
}

/**
 * Stream-driven convergence runner. Used by the production crawler's
 * sampling loop and by Phase 2.x tests that replay corpus snapshots.
 *
 * `stopOnStable` is the optimistic early-exit signal (Phase 2.1 lock — must
 * be paired with a `maxSamples` hard cap in the crawler, not here).
 */
export function runConvergence(
  docs: Iterable<Record<string, FieldObservation>>,
  stopOnStable: number,
): ConvergenceResult {
  let schema = emptySchema();
  let consecutiveStable = 0;
  let declaredAt: number | null = null;
  let totalChanges = 0;
  const missedChangesAfterDeclared: SchemaChange[] = [];
  let i = 0;

  for (const doc of docs) {
    const { next, changes } = mergeDoc(schema, doc);
    schema = next;
    totalChanges += changes.length;
    if (changes.length === 0) {
      consecutiveStable++;
      if (declaredAt === null && consecutiveStable >= stopOnStable) {
        declaredAt = i;
      }
    } else {
      consecutiveStable = 0;
      if (declaredAt !== null) {
        missedChangesAfterDeclared.push(...changes);
      }
    }
    i++;
  }

  return {
    declaredAt,
    totalDocs: i,
    totalChanges,
    finalSchema: schema,
    missedChangesAfterDeclared,
  };
}
