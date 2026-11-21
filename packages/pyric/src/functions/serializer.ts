/**
 * Wire serializer and deserializer for callable payloads, matching
 * `@firebase/functions` 0.14.0 (`encode` and `decode`).
 */

const LONG_TYPE = 'type.googleapis.com/google.protobuf.Int64Value';
const UNSIGNED_LONG_TYPE = 'type.googleapis.com/google.protobuf.UInt64Value';

function mapValues(
  input: Record<string, unknown>,
  transform: (value: unknown) => unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      result[key] = transform(input[key]);
    }
  }
  return result;
}

/**
 * Encodes request data into the JSON wire representation expected by callable
 * functions (`Date` -> ISO string, `undefined`/`null` -> `null`, non-finite
 * numbers rejected).
 */
export function encode(rawData: unknown): unknown {
  let data = rawData;
  if (data === null || data === undefined) {
    return null;
  }
  if (data instanceof Number) {
    data = data.valueOf();
  }
  if (typeof data === 'number' && Number.isFinite(data)) {
    return data;
  }
  if (data === true || data === false) {
    return data;
  }
  if (Object.prototype.toString.call(data) === '[object String]') {
    return data;
  }
  if (data instanceof Date) {
    return data.toISOString();
  }
  if (Array.isArray(data)) {
    return data.map((entry) => encode(entry));
  }
  if (typeof data === 'function' || typeof data === 'object') {
    return mapValues(data as Record<string, unknown>, (entry) => encode(entry));
  }
  throw new Error(`Data cannot be encoded in JSON: ${String(data)}`);
}

/**
 * Decodes callable JSON wire payloads back into client values, converting
 * protobuf `Int64Value` and `UInt64Value` wrappers into numbers.
 */
export function decode(json: unknown): unknown {
  if (json === null || json === undefined) {
    return json;
  }
  if (typeof json === 'object' && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    if (Boolean(record['@type'])) {
      const typeUrl = record['@type'];
      if (typeUrl === LONG_TYPE || typeUrl === UNSIGNED_LONG_TYPE) {
        const parsed = Number(record.value);
        if (Number.isNaN(parsed)) {
          throw new Error(`Data cannot be decoded from JSON: ${String(json)}`);
        }
        return parsed;
      }
      throw new Error(`Data cannot be decoded from JSON: ${String(json)}`);
    }
  }
  if (Array.isArray(json)) {
    return json.map((entry) => decode(entry));
  }
  if (typeof json === 'function' || typeof json === 'object') {
    return mapValues(json as Record<string, unknown>, (entry) => decode(entry));
  }
  return json;
}
