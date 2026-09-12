/**
 * Display projection of a captured Firestore query operand.
 *
 * PURE. `activity-query-value.ts` reduces an operand to a fixed-size digest so
 * two reads of the same query compare equal without the diagnostic ever
 * observing user code. A digest cannot be read back, so a surface that shows
 * the developer the query they wrote needs the operand itself.
 *
 * This module projects the CANONICAL snapshot `captureQueryOperand` already
 * took at construction time, never the caller's object. That snapshot is plain
 * frozen data — the same lifecycle point at which Firebase parses query values
 * — so walking it runs no getter and can trip no Proxy trap. The projection is
 * bounded in string length, entry count, and depth, so an attach event never
 * retains an unbounded operand tree.
 *
 * The output is diagnostic only: nothing reads it back into a query, and no
 * verdict, delivery, or query identity depends on it.
 */

/** How much of one string operand a display value carries. */
const MAX_STRING = 200;
/** How many entries of one array or map operand a display value carries. */
const MAX_ENTRIES = 10;
/** How deep into a nested operand a display value reaches. */
const MAX_DEPTH = 4;

/** One operand as a surface can print it. Tagged so a renderer never has to
 *  guess whether `12` was a number or a string. */
export type QueryDisplayValue =
  | { readonly type: 'string'; readonly value: string; readonly truncated?: true }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'null' }
  | { readonly type: 'reference'; readonly path: string }
  | { readonly type: 'timestamp'; readonly iso: string }
  | { readonly type: 'geoPoint'; readonly latitude: number; readonly longitude: number }
  | { readonly type: 'bytes'; readonly length: number }
  | { readonly type: 'vector'; readonly length: number }
  | {
    readonly type: 'array';
    readonly values: readonly QueryDisplayValue[];
    readonly truncated?: true;
  }
  | {
    readonly type: 'map';
    readonly entries: readonly (readonly [string, QueryDisplayValue])[];
    readonly truncated?: true;
  }
  | { readonly type: 'opaque' };

function displayString(value: string): QueryDisplayValue {
  return value.length <= MAX_STRING
    ? { type: 'string', value }
    : { type: 'string', value: value.slice(0, MAX_STRING), truncated: true };
}

/** Seconds and nanoseconds as the ISO instant a surface prints. */
function displayTimestamp(seconds: number, nanoseconds: number): QueryDisplayValue {
  const millis = seconds * 1_000 + Math.floor(nanoseconds / 1_000_000);
  if (!Number.isFinite(millis)) return { type: 'opaque' };
  try {
    return { type: 'timestamp', iso: new Date(millis).toISOString() };
  } catch {
    return { type: 'opaque' };
  }
}

/** A value the registry recorded for a Pyric-owned operand: a reference, a
 *  timestamp, a geo point, bytes, or a vector. */
function displayRegistered(value: unknown): QueryDisplayValue {
  if (typeof value !== 'object' || value === null) return { type: 'opaque' };
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string') return { type: 'reference', path: record.path };
  if (record.type === 'timestamp'
    && typeof record.seconds === 'number'
    && typeof record.nanoseconds === 'number') {
    return displayTimestamp(record.seconds, record.nanoseconds);
  }
  if (record.type === 'geo-point'
    && typeof record.latitude === 'number'
    && typeof record.longitude === 'number') {
    return { type: 'geoPoint', latitude: record.latitude, longitude: record.longitude };
  }
  if (record.type === 'bytes' && Array.isArray(record.values)) {
    return { type: 'bytes', length: record.values.length };
  }
  if (record.type === 'vector' && Array.isArray(record.values)) {
    return { type: 'vector', length: record.values.length };
  }
  return { type: 'opaque' };
}

function project(value: unknown, depth: number): QueryDisplayValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return displayString(value);
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value !== 'object') return { type: 'opaque' };
  if (depth >= MAX_DEPTH) return { type: 'opaque' };

  const record = value as Record<string, unknown>;
  if (record.type === 'registered-firestore-value') return displayRegistered(record.value);
  if (record.type === 'timestamp'
    && typeof record.seconds === 'number'
    && typeof record.nanoseconds === 'number') {
    return displayTimestamp(record.seconds, record.nanoseconds);
  }
  if (record.type === 'bytes' && Array.isArray(record.values)) {
    return { type: 'bytes', length: record.values.length };
  }
  if (record.type === 'array' && Array.isArray(record.values)) {
    const values = record.values.slice(0, MAX_ENTRIES).map((entry) => project(entry, depth + 1));
    return record.values.length > MAX_ENTRIES
      ? { type: 'array', values, truncated: true }
      : { type: 'array', values };
  }
  if (record.type === 'map' && Array.isArray(record.entries)) {
    const entries = record.entries
      .slice(0, MAX_ENTRIES)
      .filter((entry): entry is [string, unknown] => Array.isArray(entry)
        && typeof entry[0] === 'string')
      .map(([key, entry]) => [key, project(entry, depth + 1)] as const);
    return record.entries.length > MAX_ENTRIES
      ? { type: 'map', entries, truncated: true }
      : { type: 'map', entries };
  }
  return { type: 'opaque' };
}

/**
 * Project one canonical query operand into its display value.
 *
 * The argument is the `value` of a `CapturedQueryOperand` — the comparison
 * snapshot, not the caller's object.
 */
export function activityDisplayValue(canonical: unknown): QueryDisplayValue {
  return project(canonical, 0);
}
