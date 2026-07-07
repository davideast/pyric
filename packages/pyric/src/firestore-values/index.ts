/**
 * Firestore value codec — the marker-based serialize/rehydrate of
 * Firestore special scalar types (Timestamp, Bytes, LatLng/GeoPoint,
 * Duration, Reference, Path, Vector).
 *
 * WHY THIS MODULE EXISTS (and why it is a LEAF)
 * ---------------------------------------------
 * Two very different consumers need this codec:
 *
 *   1. The sandbox persistence serializer (`sandbox/persistence/serialize.ts`)
 *      — server-side, already pulls the whole engine, doesn't care about size.
 *   2. The SharedWorker CLIENT (`pyric-tools/.../worker/client.ts` via
 *      `protocol.ts`) — runs in EVERY page that opens a serve session. It only
 *      needs to reconstruct Timestamp/Bytes/LatLng instances from the JSON
 *      markers the worker host wrote; it must NOT drag the rules engine,
 *      simulator, parser, or sandbox into the per-page bundle.
 *
 * Importing the wrapper CLASSES from the `pyric/rules` BARREL would execute the
 * entire rules index (parser + linter + simulator + evaluator → ~10 MB). The
 * wrapper modules themselves are leaf — each depends only on `wrappers/base.js`
 * which has zero imports — so this codec imports them by their DIRECT leaf
 * paths. The result: importing this module pulls ONLY the seven small wrapper
 * classes + their `base.js`, nothing heavy.
 *
 * Real types, not structural stand-ins: because the wrapper constructors are
 * already leaf-cheap, the codec reconstructs the SAME real `Timestamp`/`Bytes`/
 * `LatLng`/etc. classes the in-page (`pyric/firestore`) path yields. This keeps
 * `instanceof` checks and method calls (`.toDate()`, `.toMillis()`, byte
 * access, `.lat`/`.lng`) identical on both sides of the MessagePort and in IDB
 * persistence — there is ONE codec, not two that can drift.
 *
 * Marker formats handled (must stay in sync with each wrapper's `toJSON()`):
 *
 * 1. `pyric/rules` wrapper markers (from `Timestamp.toJSON()` etc.):
 *   { __type: 'timestamp', seconds, nanos }   → Timestamp
 *   { __type: 'bytes', base64 }               → Bytes   (base64url)
 *   { __type: 'latlng', lat, lng }            → LatLng
 *   { __type: 'duration', seconds, nanos }    → Duration
 *   { __type: 'reference', path }             → Reference
 *   { __type: 'path', segments }              → Path
 *   { __type__: '__vector__', value }         → Vector
 *
 * 2. `firebase/firestore` SDK markers (from fb.Timestamp.toJSON() etc.),
 *    produced when `pyric/firestore`'s `getDoc` returns `firebase/firestore`
 *    class instances that are then serialized via JSON.stringify:
 *   { type: 'firestore/timestamp/1.0', seconds, nanoseconds } → Timestamp
 *   { type: 'firestore/bytes/1.0', bytes }                    → Bytes (std b64)
 *   { type: 'firestore/geoPoint/1.0', latitude, longitude }   → LatLng
 *
 * Unknown `__type`/`type` values pass through as plain objects rather than
 * throwing — the rest of the doc still restores cleanly.
 */

// Direct leaf imports — NOT the `pyric/rules` barrel. Each of these modules
// depends only on `./base.js` (no imports), so this stays engine-free.
import { Bytes } from '../rules/simulator/wrappers/bytes.js';
import { Duration } from '../rules/simulator/wrappers/duration.js';
import { LatLng } from '../rules/simulator/wrappers/latlng.js';
import { Path } from '../rules/simulator/wrappers/path.js';
import { Reference } from '../rules/simulator/wrappers/reference.js';
import { Timestamp } from '../rules/simulator/wrappers/timestamp.js';
import { Vector } from '../rules/simulator/wrappers/vector.js';

/**
 * Decode a base64url string (`-`/`_` alphabet, no padding) back into a
 * Uint8Array. Mirrors the encode path in `Bytes.toBase64` (RFC 4648 section 5).
 */
function base64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode a standard base64 string (`+`/`/` alphabet, possibly `=`-padded)
 * back to a Uint8Array. Used for `firebase/firestore` Bytes which encode in
 * standard base64 (unlike pyric/rules Bytes which use base64url).
 */
function base64StdDecode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Walk a parsed JSON tree and re-wrap any marker shape back into its real
 * wrapper-class instance. Visits arrays and plain objects recursively. Plain
 * values (and plain objects without a recognized discriminator) pass through.
 *
 * This is the canonical rehydrate used by BOTH the sandbox persistence
 * serializer and the SharedWorker wire protocol, so the IDB format and the
 * MessagePort wire format are guaranteed identical.
 */
export function rehydrateDocValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(rehydrateDocValue);

  const obj = value as Record<string, unknown>;

  if (obj.__type__ === '__vector__' && Array.isArray(obj.value)) {
    return new Vector(obj.value as number[]);
  }

  // pyric/rules wrapper marker form (used for IDB persistence + wire).
  if (typeof obj.__type === 'string') {
    switch (obj.__type) {
      case 'timestamp':
        return new Timestamp(obj.seconds as number, obj.nanos as number);
      case 'bytes':
        return new Bytes(base64UrlDecode(obj.base64 as string));
      case 'latlng':
        return new LatLng(obj.lat as number, obj.lng as number);
      case 'duration':
        return new Duration(obj.seconds as number, obj.nanos as number);
      case 'reference':
        return new Reference(obj.path as string);
      case 'path':
        return new Path(obj.segments as string[]);
    }
  }

  // firebase/firestore SDK marker form (produced when pyric/firestore's
  // getDoc returns fb-SDK class instances and JSON.stringify is called).
  if (typeof obj.type === 'string') {
    switch (obj.type) {
      case 'firestore/timestamp/1.0': {
        // fb.Timestamp.toJSON() emits { type, seconds, nanoseconds }.
        // The rules Timestamp uses nanos (not nanoseconds) — same value.
        const seconds = obj.seconds as number;
        const nanoseconds = obj.nanoseconds as number;
        return new Timestamp(seconds, nanoseconds);
      }
      case 'firestore/bytes/1.0': {
        // fb.Bytes.toJSON() emits { type, bytes } where bytes is standard base64.
        return new Bytes(base64StdDecode(obj.bytes as string));
      }
      case 'firestore/geoPoint/1.0': {
        // fb.GeoPoint.toJSON() emits { latitude, longitude, type }.
        return new LatLng(obj.latitude as number, obj.longitude as number);
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = rehydrateDocValue(v);
  return out;
}
