/**
 * Value codec for the remote arm's wire — write-data encoding (client →
 * wire marker forms) and read-data decoding (wire → compat shapes).
 *
 * VALUE CODEC: write payloads are encoded CLIENT-side to the plain-JSON
 * marker forms the worker host rehydrates (`prepareWriteData`): admin
 * `FieldValue` sentinels (`{ __type: 'increment', value }`) become wire
 * `SentinelMarker`s (`{ __sentinel: 'increment', n }`), and Timestamp /
 * Date / rules-wrapper scalars become their `toJSON()` marker shapes — so
 * the worker STORES real typed values (rules comparisons and `orderBy`
 * see a Timestamp, not a map). Read payloads arrive as the
 * `SerializedDocData` JSON envelope and are rehydrated with the ONE shared
 * codec (`pyric/firestore-values`' `rehydrateDocValue`) then translated to
 * the compat field shapes (`translateReadData`) — the same shapes the
 * local arm's read path yields.
 *
 * KNOWN CODEC DIVERGENCE (accepted): user data that happens to be SHAPED
 * like a codec marker — a plain map such as `{ __type: 'timestamp',
 * seconds, nanos }` or `{ type: 'firestore/timestamp/1.0', … }` — is
 * TRANSMUTED into the real typed value on the relayed path (the host's
 * `prepareWriteData` / constraint rehydration cannot tell an intentional
 * marker from a lookalike), while an in-page `setDoc` of the same map
 * stores a plain map. This is the persistence codec's own behavior (an
 * IndexedDB save/reload transmutes the same shapes), so the relay is
 * consistent with the sandbox's durability semantics rather than with
 * the in-page live path — marker-shaped user data is already reserved
 * vocabulary in this system.
 */

import { rehydrateDocValue } from 'pyric/firestore-values';
import {
  Timestamp as CompatTimestamp,
  type DocumentData,
  type FieldValueSentinel,
} from 'pyric/sandbox/admin-compat';
import { translateReadData } from '../../../firestore/sandbox/admin-compat/read-translation.js';
import { invalidArgument } from './errors.js';
import type { WireDocData } from './wire-types.js';

// ─── Write-data encoding (client → wire marker forms) ─────────────────────

const SENTINEL_TYPES: ReadonlySet<string> = new Set([
  'serverTimestamp',
  'increment',
  'arrayUnion',
  'arrayRemove',
  'deleteField',
]);

function isFieldValueSentinel(v: unknown): v is FieldValueSentinel {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { __type?: unknown }).__type === 'string' &&
    SENTINEL_TYPES.has((v as { __type: string }).__type)
  );
}

/** Admin `FieldValue` sentinel (`__type` shape) → the documented wire
 *  `SentinelMarker` (`__sentinel` shape) the worker host resolves. */
function encodeSentinel(s: FieldValueSentinel): unknown {
  switch (s.__type) {
    case 'serverTimestamp':
      return { __sentinel: 'serverTimestamp' };
    case 'increment':
      return { __sentinel: 'increment', n: s.value };
    case 'arrayUnion':
      return { __sentinel: 'arrayUnion', values: s.values.map(encodeValue) };
    case 'arrayRemove':
      return { __sentinel: 'arrayRemove', values: s.values.map(encodeValue) };
    case 'deleteField':
      return { __sentinel: 'deleteField' };
  }
}

/**
 * Encode ONE value for the wire: sentinels → markers, typed scalars →
 * their `toJSON()` marker shapes, containers walked recursively.
 *
 * Typed scalars are encoded EXPLICITLY (not left for a JSON leg to
 * flatten) so the wire form is transport-independent — the same frames
 * work over structured clone and over the double-JSON WS relay. The
 * host's `prepareWriteData` rehydrates every marker family back into
 * real wrapper instances before the write, which is what makes the
 * worker STORE typed values (the spike's gap-4 semantics).
 */
export function encodeValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (isFieldValueSentinel(v)) return encodeSentinel(v);
  if (v instanceof CompatTimestamp) return v.toJSON();
  if (v instanceof Date) return CompatTimestamp.fromDate(v).toJSON();
  if (Array.isArray(v)) return v.map(encodeValue);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    // Non-plain instance (rules-wrapper Bytes/LatLng/Duration/… — the
    // shapes the local read path hands back). Their `toJSON()` emits the
    // canonical `__type` marker the shared codec rehydrates. Instances
    // without a toJSON have no wire form — surface that honestly.
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return (toJSON as () => unknown).call(v);
    }
    throw invalidArgument(
      `remote Firestore: cannot serialize a ${proto.constructor?.name ?? 'class'} ` +
        'instance for the wire — use plain data, Timestamp, Date, or FieldValue sentinels.',
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = encodeValue(val);
  }
  return out;
}

export function encodeWriteData(data: DocumentData): unknown {
  return encodeValue(data);
}

// ─── Read-data decoding (wire → compat shapes) ─────────────────────────────

/** Parse the JSON envelope with the shared codec, but keep the values in
 *  their RULES-INTERNAL wrapper form (what the local engine stores). Used
 *  where a downstream helper does its own compat translation. */
export function decodeInternal(serialized: WireDocData): DocumentData {
  return rehydrateDocValue(JSON.parse(serialized.json)) as DocumentData;
}

/** Full read-path decode: shared codec rehydration + the same
 *  internal→compat field-shape translation the local arm applies
 *  (`Timestamp{seconds,nanoseconds}`, not the rules wrapper). */
export function decodeDocData(serialized: WireDocData): DocumentData {
  return translateReadData(decodeInternal(serialized));
}
