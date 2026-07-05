/**
 * Vector wrapper — Item 5 of simulator-prod-parity.md.
 *
 * Vector surface (rules side):
 *   The Firestore Rules language does NOT expose a `vector` type test
 *   or any vector-specific properties. Vectors exist purely on the data
 *   side — they round-trip through wire encoding so that the discover
 *   crawler reports `kind: 'vector', dimension: N`, and so that rules
 *   that treat the field as an opaque map (`field is map`, etc.) see
 *   the sentinel shape live Firestore would expose.
 *
 *   Because there's no `is vector` in the grammar, the wrapper's
 *   typeName isn't a parser-visible token; it's still recorded for
 *   diagnostics and the toJSON debug shape.
 *
 * Per 0.B per-wrapper table:
 *   typeName: 'vector'
 *   valueOf:  NaN          (no meaningful numeric coercion)
 *   toString: '[v0, v1, ...]'  (human-readable, no parser round-trip)
 *   equals:   element-wise equality on .value arrays
 *   binaryOp: NO_OP (no defined cross-type ops)
 *
 * Why a class wrapper rather than a plain `{__type__: '__vector__'}`
 * object: the write-boundary resolver descends into plain objects but
 * skips class instances. Wrapping in a class is what makes "agent
 * passes admin SDK VectorValue" round-trip cleanly without having to
 * detect the sentinel map at every read site too.
 */
import { RulesValue, NO_OP, type NoOp } from './base.js';

export class Vector extends RulesValue {
  readonly typeName = 'vector';

  /** Defensive copy of the input array — Vector instances are immutable. */
  readonly value: readonly number[];

  constructor(value: readonly number[]) {
    super();
    if (!Array.isArray(value)) {
      throw new TypeError('Vector: value must be a number[]');
    }
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'number') {
        throw new TypeError(
          `Vector: element at index ${i} is not a number (got ${typeof value[i]})`,
        );
      }
    }
    // Freeze a copy so callers can't mutate the wrapper after construction.
    this.value = Object.freeze(value.slice());
  }

  /** Length of the vector — how many components it has. */
  get dimension(): number {
    return this.value.length;
  }

  // ─── RulesValue contract ─────────────────────────────────────────────

  valueOf(): number {
    return NaN; // No meaningful numeric coercion.
  }

  toString(): string {
    return `[${this.value.join(', ')}]`;
  }

  toJSON(): unknown {
    // Mirrors the wire sentinel shape (`__type__`/`value`) so a
    // JSON.stringify round-trip looks like the encoded form a
    // discover crawler would see.
    return { __type__: '__vector__', value: this.value.slice() };
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Vector)) return false;
    if (other.value.length !== this.value.length) return false;
    for (let i = 0; i < this.value.length; i++) {
      if (other.value[i] !== this.value[i]) return false;
    }
    return true;
  }

  callMethod(_method: string, _args: unknown[]): unknown | NoOp {
    // No methods exposed to rules.
    return NO_OP;
  }
}
