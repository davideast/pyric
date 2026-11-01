/**
 * Case values in the form the production Rules Test API reads them.
 *
 * The Rules Test API takes a case's documents as plain JSON and reads some
 * JSON shapes as typed values (captured 2026-10-28, fixture
 * `packages/pyric/test/rules/test/fixtures/case-wire/captures.json`):
 *   - a string holding an ISO-8601 instant with an offset reads as a timestamp;
 *   - a map holding exactly `latitude` and `longitude` reads as a latlng;
 *   - a string of seconds ending in `s`, such as `"1.5s"`, reads as a duration;
 *   - a string starting with `/` reads as a path, the type rules give a
 *     reference field.
 * A value helper's value is sent in that form, so production reads the typed
 * value the simulator reads (FS2-CON-5). Bytes and vectors have no form the
 * Rules Test API reads as that type, so a case holding one is refused rather
 * than sent as something else. A plain map, including one with a `__type`
 * key, is sent as the map it is.
 */
import { Bytes } from '../simulator/wrappers/bytes.js';
import { Duration } from '../simulator/wrappers/duration.js';
import { RulesFloat } from '../simulator/wrappers/float.js';
import { LatLng } from '../simulator/wrappers/latlng.js';
import { Reference } from '../simulator/wrappers/reference.js';
import { Timestamp } from '../simulator/wrappers/timestamp.js';
import { Vector } from '../simulator/wrappers/vector.js';
import { RulesValue } from '../simulator/wrappers/base.js';

const NANOS_PER_SECOND = 1_000_000_000n;
const DOCUMENTS_ROOT = '/databases/(default)/documents/';

/** A duration as the Rules Test API's seconds string, such as `-1.500000000s`. */
function durationWireForm(value: Duration): string {
  const total = BigInt(value.seconds) * NANOS_PER_SECOND + BigInt(value.nanos);
  const isNegative = total < 0n;
  const magnitude = isNegative ? -total : total;
  const whole = magnitude / NANOS_PER_SECOND;
  const fraction = (magnitude % NANOS_PER_SECOND).toString().padStart(9, '0');
  return `${isNegative ? '-' : ''}${whole}.${fraction}s`;
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function untransportable(kind: string, field: string): TypeError {
  return new TypeError(
    `Case refused: ${field} is a ${kind} value, and the Rules Test API has no form it reads as a ${kind}. `
    + `Test this case with simulate(), or leave the ${kind} field out of the production test.`,
  );
}

function encodeRulesValue(value: RulesValue, field: string): unknown {
  if (value instanceof Timestamp) return value.toString();
  if (value instanceof LatLng) return { latitude: value.lat, longitude: value.lng };
  if (value instanceof Duration) return durationWireForm(value);
  if (value instanceof Reference) return `${DOCUMENTS_ROOT}${value.path}`;
  if (value instanceof RulesFloat) return value.value;
  if (value instanceof Bytes) throw untransportable('bytes', field);
  if (value instanceof Vector) throw untransportable('vector', field);
  throw untransportable(value.typeName, field);
}

/**
 * `value` in the form the Rules Test API reads. `field` names where it sits in
 * the case, such as `data.at`, for the refusal a value with no such form gets.
 *
 * @throws {TypeError} for a bytes or vector value.
 */
export function encodeWireValue(value: unknown, field: string): unknown {
  if (value instanceof RulesValue) return encodeRulesValue(value, field);
  if (Array.isArray(value)) return value.map((item, i) => encodeWireValue(item, `${field}[${i}]`));
  if (!isPlainMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = encodeWireValue(child, `${field}.${key}`);
  }
  return out;
}

/** A case document in the form the Rules Test API reads. */
export function encodeWireDocument(doc: Record<string, unknown>, field: string): Record<string, unknown> {
  return encodeWireValue(doc, field) as Record<string, unknown>;
}
