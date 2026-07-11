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

/**
 * The server-timestamp sentinel — the case-data equivalent of
 * `FieldValue.serverTimestamp()`. The simulator resolves it to the request
 * time, so a rule comparing `data.createdAt == request.time` sees a match.
 */
export function serverTimestamp(): typeof SERVER_TIMESTAMP {
  return SERVER_TIMESTAMP;
}

/**
 * A Firestore `timestamp` value.
 *   - number → milliseconds since the epoch
 *   - string → ISO-8601
 *   - object → explicit `{ seconds, nanos }`
 */
export function timestamp(
  input: number | string | { seconds: number; nanos?: number },
): Timestamp {
  if (typeof input === 'number') return Timestamp.fromMillis(input);
  if (typeof input === 'string') return Timestamp.fromIsoString(input);
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

/** A `latlng` geographic point. */
export function latlng(lat: number, lng: number): LatLng {
  return new LatLng(lat, lng);
}

/**
 * A `duration` value. `unit` is one of the Firestore duration units
 * (`'w' | 'd' | 'h' | 'm' | 's' | 'ms' | 'ns'`); defaults to seconds.
 */
export function duration(value: number, unit: string = 's'): Duration {
  return Duration.fromValue(value, unit);
}

/** A `reference` to a document, by its path (e.g. `"users/alice"`). */
export function reference(path: string): Reference {
  return new Reference(path);
}

/** A `vector` value from its numeric components. */
export function vector(values: readonly number[]): Vector {
  return new Vector(values);
}
