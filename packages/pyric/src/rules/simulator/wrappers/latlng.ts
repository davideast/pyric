/**
 * LatLng wrapper for Firestore Rules `latlng` type — Item 1.1.
 *
 * Closes the LatLng type gap from REBUILD_PLAN.md "Current Evaluator Gap
 * Analysis" — instance methods + the `latlng.value(lat, lng)` namespace
 * constructor (was the entire `latlng` namespace gap).
 *
 * Reference surface (from REBUILD_PLAN.md "Reference Inventory"):
 *   - latitude() → Float, range [-90, 90]
 *   - longitude() → Float, range [-180, 180]
 *   - distance(other: LatLng) → Float, meters
 *   - Operators: == != only (no arithmetic — see RulesValue.binaryOp note)
 *
 * Construction: `latlng.value(lat, lng)` only. Production also accepts
 * stored LatLng values from Firestore documents, but that path requires
 * test-data sentinels we haven't introduced yet — single-source
 * construction in 1.1 keeps the wrapper testable end-to-end.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

/**
 * Distance between two points on Earth, in meters, via the haversine
 * formula. Production uses WGS-84 ellipsoid math which differs from
 * haversine by up to ~0.5%. We accept that drift for Item 1 — the
 * parity pack covers exact-equality and same-point cases (where
 * haversine == ellipsoid == 0); long-distance precision parity is
 * deferred until a real-world rule surfaces a discrepancy in the
 * benchmark divergence log. If/when that happens, swap the
 * implementation here without touching the wrapper's interface.
 */
function haversineMeters(latA: number, lngA: number, latB: number, lngB: number): number {
  const R = 6371000; // mean Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const φ1 = toRad(latA);
  const φ2 = toRad(latB);
  const Δφ = toRad(latB - latA);
  const Δλ = toRad(lngB - lngA);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export class LatLng extends RulesValue {
  readonly typeName = 'latlng';
  readonly lat: number;
  readonly lng: number;

  constructor(lat: number, lng: number) {
    super();
    // Don't validate range here — production accepts out-of-range values
    // via stored data and only the namespace constructor `latlng.value`
    // would raise. Keeping the wrapper itself permissive lets storage
    // and constructor paths share the same class without divergence.
    this.lat = lat;
    this.lng = lng;
  }

  /**
   * NaN — LatLng has no meaningful numeric coercion. The 0.B contract
   * documents this explicitly: any rule that does arithmetic on a
   * LatLng (e.g. `latlng + 1`) is buggy, and NaN propagation makes
   * the failure loud rather than silent. The `binaryOp` override
   * below also returns NO_OP for everything except `==`/`!=` (which
   * route through `equals()` not `binaryOp`), so arithmetic falls
   * through to the generic numeric path → NaN → comparison fails.
   */
  valueOf(): number {
    return NaN;
  }

  toString(): string {
    return `${this.lat},${this.lng}`;
  }

  toJSON(): unknown {
    return { __type: 'latlng', lat: this.lat, lng: this.lng };
  }

  equals(other: unknown): boolean {
    return (
      other instanceof LatLng &&
      this.lat === other.lat &&
      this.lng === other.lng
    );
  }

  callMethod(method: string, args: unknown[]): unknown | NoOp {
    switch (method) {
      case 'latitude':
        return this.lat;
      case 'longitude':
        return this.lng;
      case 'distance': {
        const other = args[0];
        if (!(other instanceof LatLng)) {
          // Real type error, not a sim gap — caller throws EvalError, not
          // UnsupportedError. Returning NO_OP would mask the type bug as
          // "method not implemented", which is wrong: we *did* implement
          // distance, the caller passed garbage.
          throw new TypeError(
            `latlng.distance() requires a LatLng argument, got ${typeof other}`,
          );
        }
        return haversineMeters(this.lat, this.lng, other.lat, other.lng);
      }
      default:
        return NO_OP;
    }
  }

  // No binaryOp override — defaults to NO_OP, so arithmetic falls
  // through to the generic numeric switch which produces NaN. == / !=
  // route through deepEqualsForRules → equals(). This is correct.
}
