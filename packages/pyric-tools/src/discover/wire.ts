/**
 * Firestore wire-format → FieldObservation conversion.
 *
 * The SDK boundary for `firestore_discover_paths`. Reads the private
 * `DocumentSnapshot._fieldsProto` representation per the Phase 0.1 lock
 * (numberTypeStrategy: "wire" — preserves integerValue/doubleValue
 * distinction at the value boundary).
 *
 * Three responsibilities:
 *   1. Validate `_fieldsProto` is present and shaped as expected. Fail
 *      loud if absent (prerequisite 0.A — silent fallback to data() would
 *      collapse all numeric types and corrupt downstream codegen).
 *   2. Convert each wire value into a FieldObservation suitable for
 *      `mergeDoc` — including the example projection and the enum sample.
 *   3. Flag reserved field names (prerequisite 0.B) so codegen layers can
 *      skip or sanitize.
 */

import type { FieldObservation } from './merge.js';
import { fieldTypeKey } from './merge.js';
import type {
  ExampleValue,
  FieldType,
  ReservedFieldReason,
} from './types.js';

// ─── Error type for 0.A ───────────────────────────────────────────────────

/**
 * Thrown when `DocumentSnapshot._fieldsProto` is unavailable or malformed.
 * Per prerequisite 0.A, the wire reader does NOT silently fall back to
 * `data()` — that would collapse integer/double at the value boundary
 * and corrupt every downstream codegen consumer.
 */
export class WireProtoUnavailableError extends Error {
  override readonly name = 'WireProtoUnavailableError';
  constructor(opts: { docPath: string; reason: string }) {
    super(
      `firestore_discover_paths could not read wire types from document ` +
        `"${opts.docPath}": ${opts.reason}. The discover_paths tool depends on ` +
        `firebase-admin DocumentSnapshot._fieldsProto for accurate ` +
        `integer/double type inference (Phase 0.1 lock). If this is a ` +
        `firebase-admin upgrade incompatibility, set ` +
        `numberTypeStrategy: "heuristic" to opt into the lossy fallback ` +
        `knowingly. Otherwise file an issue with the admin SDK version.`,
    );
  }
}

// ─── Reserved-name detection (0.B) ────────────────────────────────────────

const FIRESTORE_RESERVED_NAMES = new Set(['__name__']);

/**
 * Classify a field name. Returns undefined for normal names, or a
 * specific ReservedFieldReason for names that codegen must skip/sanitize.
 *
 * Rules ordered by specificity (most specific first):
 *   - exact `__name__` etc. → firestore_reserved_name
 *   - contains '.'          → dotted_field_name (breaks dot-path access)
 *   - pure-numeric          → numeric_field_name (looks like array index)
 *   - __foo__               → double_underscore_wrap (sentinel collision)
 */
export function classifyFieldName(name: string): ReservedFieldReason | undefined {
  if (FIRESTORE_RESERVED_NAMES.has(name)) return 'firestore_reserved_name';
  if (name.includes('.')) return 'dotted_field_name';
  if (/^-?\d+$/.test(name)) return 'numeric_field_name';
  if (name.length >= 4 && name.startsWith('__') && name.endsWith('__')) {
    return 'double_underscore_wrap';
  }
  return undefined;
}

// ─── Wire value → FieldType ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WireValue = any;

/**
 * Pure type extraction. Does not extract examples or enum samples — use
 * `wireValueToObservation` for the full observation.
 */
export function wireValueToFieldType(v: WireValue): FieldType {
  if ('nullValue' in v) return { kind: 'scalar', type: 'null' };
  if ('booleanValue' in v) return { kind: 'scalar', type: 'boolean' };
  if ('integerValue' in v) return { kind: 'scalar', type: 'integer' };
  if ('doubleValue' in v) return { kind: 'scalar', type: 'double' };
  if ('timestampValue' in v) return { kind: 'scalar', type: 'timestamp' };
  if ('stringValue' in v) return { kind: 'scalar', type: 'string' };
  if ('bytesValue' in v) return { kind: 'scalar', type: 'bytes' };
  if ('geoPointValue' in v) return { kind: 'scalar', type: 'geopoint' };

  if ('referenceValue' in v) {
    return {
      kind: 'reference',
      targetCollection: parseRefTargetCollectionPath(v.referenceValue),
    };
  }

  if ('arrayValue' in v) {
    const values: WireValue[] = v.arrayValue?.values ?? [];
    const elementTypes = values.map(wireValueToFieldType);
    const seen = new Set<string>();
    const deduped = elementTypes.filter((t) => {
      const k = fieldTypeKey(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { kind: 'array', elementTypes: deduped };
  }

  if ('mapValue' in v) {
    const fieldsObj: Record<string, WireValue> = v.mapValue?.fields ?? {};
    // Vector sentinel detection (Phase 1.2 lock)
    const sentinel = fieldsObj['__type__'];
    if (sentinel?.stringValue === '__vector__') {
      const arr = fieldsObj['value']?.arrayValue?.values ?? [];
      return { kind: 'vector', dimension: arr.length };
    }
    const fields: Record<string, ReturnType<typeof descriptorFromObservation>> = {};
    for (const [k, sub] of Object.entries(fieldsObj)) {
      fields[k] = descriptorFromObservation(wireValueToObservation(sub));
    }
    return { kind: 'map', fields };
  }

  throw new Error(`Unrecognized wire value: ${JSON.stringify(Object.keys(v))}`);
}

// ─── Wire value → FieldObservation ────────────────────────────────────────

/**
 * Full observation including JSON-safe example projection and enum sample
 * extraction. The merge layer consumes this shape.
 */
export function wireValueToObservation(v: WireValue): FieldObservation {
  const type = wireValueToFieldType(v);
  const isNull = type.kind === 'scalar' && type.type === 'null';
  const example = exampleFromWire(v);
  const enumSample = enumSampleFromWire(v, type);
  return { type, isNull, example, enumSample };
}

/** Project a wire value into a JSON-safe example. */
function exampleFromWire(v: WireValue): ExampleValue | undefined {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue as boolean;
  if ('stringValue' in v) return v.stringValue as string;
  if ('integerValue' in v) {
    const raw = v.integerValue as string | number;
    // integerValue is wire-encoded as a string (int64). Parse but cap at
    // safe integer range; outside that, return as-string to preserve.
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (Number.isSafeInteger(n)) return n;
    return String(raw);
  }
  if ('doubleValue' in v) return v.doubleValue as number;
  // timestamp/bytes/geopoint/reference: not codegen-friendly placeholders;
  // omit so descriptor.example stays undefined and codegen knows to skip.
  if ('timestampValue' in v) return undefined;
  if ('bytesValue' in v) return undefined;
  if ('geoPointValue' in v) return undefined;
  if ('referenceValue' in v) return undefined;

  if ('arrayValue' in v) {
    const values: WireValue[] = v.arrayValue?.values ?? [];
    const projected: ExampleValue[] = [];
    for (const e of values) {
      const proj = exampleFromWire(e);
      // Skip elements that don't project (e.g., bytes inside an array).
      // Better than nulling them out — keeps the example shape useful.
      if (proj !== undefined) projected.push(proj);
    }
    return projected;
  }

  if ('mapValue' in v) {
    const fieldsObj: Record<string, WireValue> = v.mapValue?.fields ?? {};
    if (fieldsObj['__type__']?.stringValue === '__vector__') return undefined;
    const out: { [k: string]: ExampleValue } = {};
    for (const [k, sub] of Object.entries(fieldsObj)) {
      const proj = exampleFromWire(sub);
      if (proj !== undefined) out[k] = proj;
    }
    return out;
  }

  return undefined;
}

/** Extract an enum sample if the type is enum-eligible (string/int/double). */
function enumSampleFromWire(v: WireValue, type: FieldType): string | number | undefined {
  if (type.kind !== 'scalar') return undefined;
  if (type.type === 'string') return v.stringValue as string;
  if (type.type === 'integer') {
    const raw = v.integerValue as string | number;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (type.type === 'double') return v.doubleValue as number;
  return undefined;
}

/** Tiny adapter — turns a single observation into a one-shot descriptor for
 *  nested map fields. Mirrors what mergeDoc does for first-time keys. */
function descriptorFromObservation(obs: FieldObservation) {
  const isNull = obs.isNull;
  return {
    types: isNull ? [] : [obs.type],
    presenceSeen: 1,
    presenceTotal: 1,
    nullable: isNull,
    enumCandidate:
      !isNull &&
      obs.type.kind === 'scalar' &&
      (obs.type.type === 'string' ||
        obs.type.type === 'integer' ||
        obs.type.type === 'double') &&
      obs.enumSample !== undefined
        ? { qualifies: false, values: [obs.enumSample], threshold: 10 }
        : undefined,
    example: obs.example,
  };
}

// ─── Reference path parsing ───────────────────────────────────────────────

/**
 * Parse a referenceValue string into the full collection path of the target.
 *
 * Format: projects/<p>/databases/<d>/documents/<coll>/<doc>[/<coll>/<doc>...]
 * For `projects/x/databases/(default)/documents/users/uid_1/posts/p_1`,
 * returns `users/uid_1/posts` (full path, Phase 1.2 lock for unambiguity).
 *
 * Note: this is the *literal* path of the observed reference. Callers that
 * want the template form must substitute doc IDs into wildcards based on
 * the parent collection's template path.
 */
function parseRefTargetCollectionPath(refPath: string): string {
  const idx = refPath.indexOf('/documents/');
  if (idx === -1) return refPath; // unparseable; preserve raw
  const tail = refPath.slice(idx + '/documents/'.length);
  const segments = tail.split('/');
  if (segments.length < 2 || segments.length % 2 !== 0) return tail;
  return segments.slice(0, -1).join('/');
}

// ─── Document snapshot → observations ─────────────────────────────────────

/**
 * Minimal shape of the firebase-admin DocumentSnapshot needed by this
 * module. Defined here to avoid pulling firebase-admin types into a pure
 * data file — the crawler/handler layer is responsible for handing us
 * objects that satisfy this shape.
 */
export interface WireDocumentSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _fieldsProto?: Record<string, any>;
  ref?: { path?: string };
}

/**
 * Convert a Firestore document snapshot into a FieldObservation map.
 * Detects reserved field names per 0.B — they appear in the output but
 * the descriptor returned by the merge layer carries `reservedReason`
 * so codegen can skip them.
 *
 * Throws `WireProtoUnavailableError` if `_fieldsProto` is absent (0.A
 * fail-loud contract). Empty docs (proto present but zero keys) return
 * an empty record without throwing.
 */
export function snapshotToObservations(snap: WireDocumentSnapshot): {
  observations: Record<string, FieldObservation>;
  reservedNames: Record<string, ReservedFieldReason>;
} {
  const proto = snap._fieldsProto;
  const docPath = snap.ref?.path ?? '<unknown>';

  if (proto === undefined || proto === null) {
    throw new WireProtoUnavailableError({
      docPath,
      reason: '_fieldsProto is undefined; firebase-admin SDK contract may have changed',
    });
  }

  const observations: Record<string, FieldObservation> = {};
  const reservedNames: Record<string, ReservedFieldReason> = {};

  for (const [k, v] of Object.entries(proto)) {
    // Sanity check: every value must have a valueType discriminator (or
    // one of the explicit *Value keys). If neither is present, we're
    // looking at a shape we don't recognize — fail loud.
    if (v == null || (typeof v !== 'object')) {
      throw new WireProtoUnavailableError({
        docPath,
        reason: `field "${k}" has non-object proto value (${typeof v}); SDK contract may have changed`,
      });
    }
    if (!hasAnyKnownValueKey(v)) {
      throw new WireProtoUnavailableError({
        docPath,
        reason: `field "${k}" has no recognizable valueType discriminator; SDK contract may have changed`,
      });
    }

    const reason = classifyFieldName(k);
    if (reason) reservedNames[k] = reason;
    observations[k] = wireValueToObservation(v);
  }

  return { observations, reservedNames };
}

const KNOWN_VALUE_KEYS = [
  'nullValue',
  'booleanValue',
  'integerValue',
  'doubleValue',
  'timestampValue',
  'stringValue',
  'bytesValue',
  'geoPointValue',
  'referenceValue',
  'arrayValue',
  'mapValue',
] as const;

function hasAnyKnownValueKey(v: Record<string, unknown>): boolean {
  for (const k of KNOWN_VALUE_KEYS) if (k in v) return true;
  // valueType discriminator alone (without a peer *Value key) is NOT
  // sufficient — some SDK versions emit it but still need the parallel
  // key for value access.
  return false;
}
