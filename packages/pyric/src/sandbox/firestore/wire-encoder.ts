/**
 * Wire-format encoder — synthesizes Firestore `_fieldsProto` from plain
 * JavaScript values stored in {@link LocalState}.
 *
 * Background: `firestore_discover_paths` reads document type information
 * from `DocumentSnapshot._fieldsProto` (Phase 0.A lock — fail loud if
 * absent, never silently fall back to `data()`). The local simulator
 * stores plain objects, so to drive the same crawler against the
 * simulator we round-trip plain values into the wire shape that
 * `wire.ts` consumes.
 *
 * Type mapping (plain JS → wire discriminator):
 *   - `null`                → `{ nullValue: null }`
 *   - `boolean`             → `{ booleanValue }`
 *   - integer `number`      → `{ integerValue: String(n) }` (matches admin SDK's int64 encoding)
 *   - non-integer `number`  → `{ doubleValue }`
 *   - `string`              → `{ stringValue }`
 *   - `Date`                → `{ timestampValue: { seconds, nanos } }` (Item 1)
 *   - `Timestamp` wrapper   → `{ timestampValue: { seconds, nanos } }` (Item 1)
 *   - `Reference` wrapper   → `{ referenceValue: 'projects/.../documents/<path>' }` (Item 3)
 *   - `Array`               → `{ arrayValue: { values } }`
 *   - plain object          → `{ mapValue: { fields } }`
 *
 * Limitations:
 *   - `Buffer`, `GeoPoint`, BigInt and vector sentinels are NOT encoded —
 *     agents seeding the simulator for discover_paths testing should stick
 *     to the supported shapes.
 *     If extended later, follow the discriminator forms in
 *     {@link ../discover/wire.ts} verbatim.
 */
import { Timestamp } from 'pyric/rules/internal';
import { Reference, referenceToResourceName } from 'pyric/rules/internal';
import { Vector } from 'pyric/rules/internal';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WireValue = Record<string, any>;

/**
 * Encode a plain value into a single Firestore wire-format value.
 * Throws on unsupported shapes (BigInt, Date, etc.) to surface gaps
 * rather than silently producing wrong types.
 */
export function encodeValue(v: unknown): WireValue {
  if (v === null || v === undefined) {
    // Firestore distinguishes "field absent" from "field null"; LocalState
    // stores `undefined` only when explicitly set, which is rare. Treat
    // both as `nullValue` for encoding — the merge layer will see a
    // legitimate scalar:null observation.
    return { nullValue: null };
  }
  if (typeof v === 'boolean') {
    return { booleanValue: v };
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      // admin SDK encodes int64 as a string in `integerValue` for safe-int
      // preservation. Mirror that contract so wire.ts's downstream parser
      // (Number(raw)) lands on the same value.
      return { integerValue: String(v) };
    }
    return { doubleValue: v };
  }
  if (typeof v === 'string') {
    return { stringValue: v };
  }
  // Item 1 — Timestamp wrappers and raw Dates both encode as
  // `timestampValue: { seconds, nanos }`. The Timestamp check must come
  // BEFORE the generic object-walk below; otherwise a Timestamp's plain
  // `seconds`/`nanos` fields would be re-encoded as a `mapValue`,
  // erasing the timestamp type for downstream wire decoders. Date
  // similarly must be claimed before the `typeof v === 'object'` branch.
  if (v instanceof Timestamp) {
    return { timestampValue: { seconds: v.seconds, nanos: v.nanos } };
  }
  if (v instanceof Date) {
    const ts = Timestamp.fromMillis(v.getTime());
    return { timestampValue: { seconds: ts.seconds, nanos: ts.nanos } };
  }
  // Item 3 — Reference wrapper rides out as `referenceValue`. The field
  // value is the fully-qualified resource name; discover/wire.ts strips
  // the `projects/.../documents/` prefix back to the relative collection
  // path so the schema reports `kind:'reference', targetCollection:'users'`.
  // Must be claimed BEFORE the generic object-walk below (Reference is
  // an instance, not a plain map).
  if (v instanceof Reference) {
    return { referenceValue: referenceToResourceName(v) };
  }
  // Item 5 — Vector encodes as the sentinel map shape live Firestore
  // uses for its embedding type. discover/wire.ts detects this exact
  // shape (`__type__: '__vector__'` + `value: <arrayValue>`) and reports
  // `kind: 'vector', dimension: N`. Must be claimed BEFORE the generic
  // object-walk below — Vector is a class instance, not a plain map,
  // but skipping past this branch would still emit the wrong shape via
  // the generic descent (no `__type__` field exists on the wrapper).
  if (v instanceof Vector) {
    return {
      mapValue: {
        fields: {
          __type__: { stringValue: '__vector__' },
          value: {
            arrayValue: {
              values: v.value.map((n) => ({ doubleValue: n })),
            },
          },
        },
      },
    };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((e) => encodeValue(e)) } };
  }
  if (typeof v === 'object') {
    const fields: Record<string, WireValue> = {};
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = encodeValue(sub);
    }
    return { mapValue: { fields } };
  }
  throw new Error(
    `wire-encoder: unsupported value type ${typeof v} (value=${String(v)}). ` +
      `LocalState's discover_paths adapter only supports JSON-shaped data ` +
      `(null, boolean, number, string, array, plain object).`,
  );
}

/**
 * Encode a full DocumentData record into the `_fieldsProto` shape.
 * Each top-level key becomes a wire value at the same key.
 */
export function encodeFieldsProto(data: Record<string, unknown>): Record<string, WireValue> {
  const proto: Record<string, WireValue> = {};
  for (const [k, v] of Object.entries(data)) {
    proto[k] = encodeValue(v);
  }
  return proto;
}
