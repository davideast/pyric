import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import { LatLng } from '../../rules/simulator/wrappers/latlng.js';
import type { EvalCtx } from './rules-evaluator.js';
import { RuleEvalError } from './rules-evaluation-error.js';
import {
  evalArguments,
  evalNamespaceArguments,
  expectNoArguments,
  functionNotFound,
  type MethodCall,
  type ReceiverMethods,
} from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

/** A rules number (an int, or a float wrapper) as a double, or undefined for any other value. */
function asDouble(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value instanceof RulesFloat) return value.value;
  return undefined;
}

function haversineMeters(latA: number, lngA: number, latB: number, lngB: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(latA);
  const phi2 = toRad(latB);
  const dPhi = toRad(latB - latA);
  const dLambda = toRad(lngB - lngA);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function latLngCoords(value: unknown): { latitude: number; longitude: number } | null {
  if (value instanceof StorageLatLng) {
    return { latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof LatLng) {
    return { latitude: value.lat, longitude: value.lng };
  }
  return null;
}

/**
 * `latlng.value(latitude, longitude)`: the LatLng a Firestore GeoPoint field
 * also reads as. Production evaluates the call in Storage rules (corpus
 * scenario `list-map-literals-and-slice` indexes its result) and rejects
 * coordinates outside [-90, 90] and [-180, 180]. A call with other arguments
 * or another name is an error value `&&` and `||` absorb.
 */
export function evalLatLngNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalNamespaceArguments(expr, ctx);
  if (isErr(args)) return args;
  if (expr.method !== 'value') return new RuleError(`unsupported latlng.${expr.method}()`);
  const [latitude, longitude] = args.map(asDouble);
  if (
    args.length !== 2 ||
    latitude === undefined ||
    longitude === undefined ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return new RuleError('latlng.value() expects (latitude: number, longitude: number)');
  }
  if (latitude < -90 || latitude > 90) {
    return new RuleError(`Latitude must be in the range [-90, 90], got ${latitude}.`);
  }
  if (longitude < -180 || longitude > 180) {
    return new RuleError(`Longitude must be in the range [-180, 180], got ${longitude}.`);
  }
  return new StorageLatLng(latitude, longitude);
}

export class StorageLatLng extends RulesValue {
  readonly typeName = 'latlng';
  constructor(readonly latitude: number, readonly longitude: number) {
    super();
  }
  valueOf(): number {
    return NaN;
  }
  toJSON(): unknown {
    return { __type: 'latlng', latitude: this.latitude, longitude: this.longitude };
  }
  equals(other: unknown): boolean {
    const coords = latLngCoords(other);
    if (coords !== null) {
      return coords.latitude === this.latitude && coords.longitude === this.longitude;
    }
    return (
      other instanceof RulesValue &&
      other.typeName === 'latlng' &&
      (other as any).latitude === this.latitude &&
      (other as any).longitude === this.longitude
    );
  }
  toString(): string {
    return `[${this.latitude}, ${this.longitude}]`;
  }
}

function evalLatitude(receiver: unknown, expr: MethodCall): unknown {
  const coords = latLngCoords(receiver);
  if (coords === null) throw functionNotFound('latitude');
  expectNoArguments(expr);
  return new RulesFloat(coords.latitude);
}

function evalLongitude(receiver: unknown, expr: MethodCall): unknown {
  const coords = latLngCoords(receiver);
  if (coords === null) throw functionNotFound('longitude');
  expectNoArguments(expr);
  return new RulesFloat(coords.longitude);
}

function evalDistance(receiver: unknown, expr: MethodCall, ctx: EvalCtx): unknown {
  const selfCoords = latLngCoords(receiver);
  if (selfCoords === null) throw functionNotFound('distance');
  const args = evalArguments(expr, ctx);
  if (isErr(args)) return args;
  if (args.length !== 1) {
    throw new RuleEvalError(`Incorrect number of arguments. Received: ${args.length}. Expected: latlng.distance(latlng).`);
  }
  const otherCoords = latLngCoords(args[0]);
  if (otherCoords === null) {
    return new RuleError('latlng.distance() requires a latlng argument');
  }
  return new RulesFloat(
    haversineMeters(selfCoords.latitude, selfCoords.longitude, otherCoords.latitude, otherCoords.longitude),
  );
}

export const latlngMethods: ReceiverMethods = {
  distance: evalDistance,
  latitude: evalLatitude,
  longitude: evalLongitude,
};
