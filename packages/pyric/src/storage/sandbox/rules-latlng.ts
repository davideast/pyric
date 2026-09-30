import { RulesValue } from '../../rules/simulator/wrappers/base.js';
import { RulesFloat } from '../../rules/simulator/wrappers/float.js';
import type { EvalCtx } from './rules-evaluator.js';
import { evalNamespaceArguments, type MethodCall } from './rules-method-calls.js';
import { RuleError, isRuleError as isErr } from './rules-values.js';

/** A rules number (an int, or a float wrapper) as a double, or undefined for any other value. */
function asDouble(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value instanceof RulesFloat) return value.value;
  return undefined;
}

/**
 * `latlng.value(latitude, longitude)`: the LatLng a Firestore GeoPoint field
 * also reads as. Production evaluates the call in Storage rules (corpus
 * scenario `list-map-literals-and-slice` indexes its result). A call with
 * other arguments or another name is an error value `&&` and `||` absorb.
 */
export function evalLatLngNamespace(expr: MethodCall, ctx: EvalCtx): unknown {
  const args = evalNamespaceArguments(expr, ctx);
  if (isErr(args)) return args;
  if (expr.method !== 'value') return new RuleError(`unsupported latlng.${expr.method}()`);
  const [latitude, longitude] = args.map(asDouble);
  if (args.length !== 2 || latitude === undefined || longitude === undefined) {
    return new RuleError('latlng.value() expects (latitude: number, longitude: number)');
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
  override field(name: string): unknown {
    if (name === 'latitude') return this.latitude;
    if (name === 'longitude') return this.longitude;
    return null;
  }
  equals(other: unknown): boolean {
    return (
      (other instanceof StorageLatLng || (other instanceof RulesValue && other.typeName === 'latlng')) &&
      (other as any).latitude === this.latitude &&
      (other as any).longitude === this.longitude
    );
  }
  toString(): string {
    return `[${this.latitude}, ${this.longitude}]`;
  }
}
