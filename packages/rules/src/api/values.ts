/**
 * Value helpers — small named constructors for the typed values a rules
 * case carries in its `data` / `resource`.
 *
 * These wrap the engine's value-wrapper classes (`Timestamp`, `Bytes`,
 * `LatLng`, …). The classes themselves are engine-internal: a caller writing
 * a case should not have to know whether `bytes("hi")` is a class instance
 * or a tagged object, only that it is "the bytes value for these contents".
 * The helpers give the front door a stable, class-free vocabulary.
 */

import { Timestamp } from '../simulator/wrappers/timestamp.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { LatLng } from '../simulator/wrappers/latlng.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { Reference } from '../simulator/wrappers/reference.js';
import { Vector } from '../simulator/wrappers/vector.js';
import { SERVER_TIMESTAMP } from '../simulator/handler.js';
import { isIsoInstant, ISO_INSTANT_FORM } from '../test/case-refusals.js';

/** Refuse a number a value can't hold, naming the argument. */
function requireFinite(helper: string, argument: string, value: number): void {
  if (Number.isFinite(value)) return;
  throw new TypeError(`${helper}: ${argument} must be a finite number, got ${String(value)}.`);
}

function requireRange(helper: string, argument: string, value: number, min: number, max: number): void {
  requireFinite(helper, argument, value);
  if (value >= min && value <= max) return;
  throw new TypeError(`${helper}: ${argument} must be between ${min} and ${max}, got ${value}.`);
}

/**
 * The server-timestamp sentinel — the case-data equivalent of
 * `FieldValue.serverTimestamp()` and `serverTimestamp()`. The simulator
 * resolves it to the request time (`request.time` in Firestore, `now` in
 * Realtime Database), so a rule comparing a timestamp field to the server
 * clock sees a match.
 */
export function serverTimestamp(): typeof SERVER_TIMESTAMP {
  return SERVER_TIMESTAMP;
}

/**
 * A Firestore `timestamp` value.
 *   - number → milliseconds since the epoch
 *   - string → ISO-8601 with `Z` or an explicit offset
 *   - Date   → its instant
 *   - object → explicit `{ seconds, nanos }`
 *
 * @throws {TypeError} for an input that names no instant, such as `'nope'`,
 *   an ISO string without an offset, an invalid `Date`, or `NaN`.
 */
export function timestamp(
  input: number | string | Date | { seconds: number; nanos?: number },
): Timestamp {
  if (typeof input === 'number') {
    requireFinite('timestamp()', 'milliseconds', input);
    return Timestamp.fromMillis(input);
  }
  if (typeof input === 'string') {
    if (!isIsoInstant(input)) {
      throw new TypeError(`timestamp(): ${JSON.stringify(input)} is not ${ISO_INSTANT_FORM}.`);
    }
    return Timestamp.fromIsoString(input);
  }
  if (input instanceof Date) {
    requireFinite('timestamp()', 'the Date', input.getTime());
    return Timestamp.fromMillis(input.getTime());
  }
  requireFinite('timestamp()', 'seconds', input.seconds);
  requireFinite('timestamp()', 'nanos', input.nanos ?? 0);
  return new Timestamp(input.seconds, input.nanos ?? 0);
}

/**
 * A `bytes` value.
 *   - string     → UTF-8 encoded
 *   - Uint8Array → used verbatim
 */
export function bytes(input: string | Uint8Array): Bytes {
  return typeof input === 'string' ? Bytes.fromUtf8(input) : new Bytes(input);
}

/**
 * A `latlng` geographic point.
 *
 * @throws {TypeError} for a latitude outside -90 to 90 or a longitude outside
 *   -180 to 180.
 */
export function latlng(lat: number, lng: number): LatLng {
  requireRange('latlng()', 'latitude', lat, -90, 90);
  requireRange('latlng()', 'longitude', lng, -180, 180);
  return new LatLng(lat, lng);
}

/**
 * A `duration` value. `unit` is one of the Firestore duration units
 * (`'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'ns'`); defaults to seconds.
 */
export function duration(value: number, unit: string = 's'): Duration {
  requireFinite('duration()', 'value', value);
  return Duration.fromValue(value, unit);
}

/** A `reference` to a document, by its path (e.g. `"users/alice"`). */
export function reference(path: string): Reference {
  return new Reference(path);
}

/**
 * A `vector` value from its numeric components.
 *
 * @throws {TypeError} for a component that is not a finite number.
 */
export function vector(values: readonly number[]): Vector {
  values.forEach((component, i) => requireFinite('vector()', `component ${i}`, component));
  return new Vector(values);
}
