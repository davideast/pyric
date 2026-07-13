/**
 * Type system for `firestore_discover_paths`.
 *
 * Locked by the design rationale Decisions Log.
 * Do not change shape without updating that file first; v2's `diff_schemas`
 * tool depends on these types JSON-roundtripping cleanly.
 *
 * Pure types — no runtime imports. Both the merge module and the agent-facing
 * tool surface depend on this file.
 */

// ─── Wire-derived field types ─────────────────────────────────────────────

/**
 * Firestore scalar wire types. Matches the discriminator emitted by
 * `_fieldsProto.<field>.valueType` (Phase 0.1 lock).
 *
 * `null` is represented as a scalar so descriptors can carry a single union
 * shape; the merge layer separately tracks `nullable` per descriptor.
 */
export type FirestoreScalarType =
  | 'null'
  | 'boolean'
  | 'integer'
  | 'double'
  | 'timestamp'
  | 'string'
  | 'bytes'
  | 'geopoint';

/**
 * One observed type for a field. Vector kept distinct from map per Phase 1.2
 * vector-sentinel lock; reference target is the **template-form full path**
 * per Phase 3.1 lock (`users/{userId}/posts`, not `posts`).
 */
export type FieldType =
  | { kind: 'scalar'; type: FirestoreScalarType }
  | { kind: 'reference'; targetCollection: string }
  | { kind: 'array'; elementTypes: FieldType[] }
  | { kind: 'map'; fields: Record<string, FieldDescriptor> }
  | { kind: 'vector'; dimension: number | 'mixed' };

// ─── Per-field descriptor ─────────────────────────────────────────────────

/**
 * Per-field descriptor accumulated across a sampled stream.
 *
 * - `types` is a deduped union; vector-dim drift keeps each dimension as a
 *   distinct entry by default (Phase 1.2 lock).
 * - `presenceSeen / presenceTotal` ratio drives presence-based agent UX; the
 *   denominator includes docs where the field was absent.
 * - `nullable` is an annotation, not a peer type (Phase 2.1 lock — `null`
 *   never appears as a `FieldType` in this descriptor's types[]).
 * - `enumCandidate` populated when the field qualifies per Phase 3.2 lock
 *   (`distinct ≤ 10 AND distinct ≤ samplesSeen / 2`); otherwise `undefined`.
 *   Tracked only for `scalar:string` and `scalar:integer/double`; other kinds
 *   are not enum candidates.
 * - `example` is one observed non-null value per Phase 3.2 lock. Drives form
 *   placeholders, fixtures, README payloads. JSON-stringifiable (wire-typed
 *   primitives + arrays + plain-object maps).
 * - `reservedReason` populated by the wire layer when the field name matches
 *   a reserved-name pattern per 0.B; agents/codegen use it to skip or
 *   sanitize the field.
 */
export interface FieldDescriptor {
  types: FieldType[];
  presenceSeen: number;
  presenceTotal: number;
  nullable: boolean;
  enumCandidate?: EnumCandidate;
  example?: ExampleValue;
  reservedReason?: ReservedFieldReason;
}

/** Captured low-cardinality value set for enum-candidate fields. */
export interface EnumCandidate {
  /** Whether the field still passes the threshold; flips to false if widened past it. */
  qualifies: boolean;
  /** Distinct values observed so far (string/number); ordered by first-seen. */
  values: Array<string | number>;
  /** Distinct count after which the candidate is dropped (default 10). */
  threshold: number;
}

/** A representative observed value, JSON-safe. */
export type ExampleValue =
  | string
  | number
  | boolean
  | null
  | ExampleValue[]
  | { [k: string]: ExampleValue };

/** Why a field name is flagged reserved per 0.B. */
export type ReservedFieldReason =
  | 'firestore_reserved_name' //  __name__ etc.
  | 'dotted_field_name' //         contains '.', breaks dot-path access
  | 'numeric_field_name' //        looks like an array index
  | 'double_underscore_wrap'; //   __foo__, conflicts with sentinels

// ─── Collection-level schema ──────────────────────────────────────────────

/**
 * Per-collection accumulated schema. `samplesSeen` is the doc count fed
 * through `mergeDoc`, used as the presence denominator.
 */
export interface FieldSchema {
  fields: Record<string, FieldDescriptor>;
  samplesSeen: number;
}

/**
 * 4-state classification for sampling termination per Phase 2.2 lock.
 *
 * - `converged_via_stable`: hit `stopOnStable` consecutive no-change docs.
 *   Schema is *probably* complete — known false-negative is mid-stream drift
 *   later than `stopOnStable` docs into the stable region (out of scope per
 *   Phase 2.1 lock; deferred to a future `firestore_re_crawl`).
 * - `converged_via_exhausted`: iterator returned empty before `maxSamples`.
 *   Schema is *provably* complete — we read every doc.
 * - `converged_via_max`: hit `maxSamples` cap without converging. Schema may
 *   be incomplete; agent should treat with caution.
 * - `sampling_open`: crawl interrupted (continuation boundary). Resume with
 *   the returned continuation handle to keep sampling.
 */
export type SamplingComplete =
  | 'converged_via_stable'
  | 'converged_via_exhausted'
  | 'converged_via_max'
  | 'sampling_open';

/**
 * Schema for a single collection as surfaced in the tool output's
 * `finalizedSchemas`.
 */
export interface CollectionSchema {
  templatePath: string; // e.g. "users/{userId}/posts"
  examplePath?: string; // e.g. "users/uid_42/posts" — secondary-tier per 3.2
  schema: FieldSchema;
  samplingComplete: SamplingComplete;
  declaredAt: number | null; // doc index where convergence declared, null if not
  subcollectionTemplatePaths: string[]; // discovered child template paths
}

// ─── Field path + change events ───────────────────────────────────────────

/**
 * Path within a doc to a field. `'[]'` segment denotes array element scope,
 * used for nested-array/map descriptors.
 */
export type FieldPath = ReadonlyArray<string | '[]'>;

/**
 * Frozen `SchemaChange` enum per Phase 5 implementation plan lock. Emitted
 * by the merge layer; carried in `schema_updated` events.
 *
 * Renamed from v1 scope's `ChangeReason` to match the agent-facing terminology
 * in the validation plan's event-model lock.
 */
export type SchemaChange =
  | { kind: 'field_added'; path: FieldPath; type: FieldType }
  | { kind: 'type_expanded'; path: FieldPath; addedType: FieldType }
  | { kind: 'presence_changed'; path: FieldPath; presenceSeen: number; presenceTotal: number }
  | { kind: 'enum_added'; path: FieldPath; values: Array<string | number> }
  | { kind: 'enum_widened'; path: FieldPath; addedValue: string | number }
  | { kind: 'enum_dropped'; path: FieldPath; reason: 'over_threshold' | 'type_widened' }
  | { kind: 'vector_dim_drift'; path: FieldPath; addedDimension: number }
  | { kind: 'became_nullable'; path: FieldPath };

// ─── Discover events (agent-facing) ───────────────────────────────────────

/**
 * Event stream emitted by `firestore_discover_paths`. Frozen enum per
 * Phase 3.3 lock. Order within a batch is meaningful — agents may rely on
 * `collection_discovered` arriving before `schema_updated` for the same path.
 */
export type DiscoverEvent =
  | { kind: 'collection_discovered'; templatePath: string; depth: number; parentPath?: string }
  | { kind: 'schema_updated'; templatePath: string; changes: SchemaChange[] }
  | {
      kind: 'sampling_complete';
      templatePath: string;
      samplingComplete: SamplingComplete;
      samplesSeen: number;
      declaredAt: number | null;
    }
  | { kind: 'error'; templatePath: string; code: string; message: string };
