/**
 * Base contract for RulesValue (Item 1.0). These tests pin the dispatch
 * defaults so future wrappers can assume:
 *   - NO_OP from binaryOp / callMethod = "fall through"
 *   - field() default = null (mirrors Firestore "missing key reads as null")
 *   - typeName is required (used by isExpr dispatch)
 *
 * Concrete wrapper coverage lives in <wrapper>.test.ts files (1.1–1.4).
 */
import { describe, test, expect } from 'bun:test';
import { RulesValue, NO_OP } from '../../../../src/rules/simulator/wrappers/base.js';

class StubValue extends RulesValue {
  readonly typeName = 'stub';
  constructor(private readonly v: number) { super(); }
  valueOf(): number { return this.v; }
  toString(): string { return `stub(${this.v})`; }
  toJSON(): unknown { return { __type: 'stub', v: this.v }; }
  equals(other: unknown): boolean {
    return other instanceof StubValue && other.v === this.v;
  }
}

describe('RulesValue base contract', () => {
  test('field() defaults to null for any property', () => {
    const s = new StubValue(1);
    expect(s.field('anything')).toBeNull();
    expect(s.field('size')).toBeNull();
    expect(s.field('')).toBeNull();
  });

  test('callMethod() defaults to NO_OP — caller throws UnsupportedError', () => {
    const s = new StubValue(1);
    expect(s.callMethod('foo', [])).toBe(NO_OP);
    expect(s.callMethod('size', [1, 2])).toBe(NO_OP);
  });

  test('binaryOp() defaults to NO_OP — caller falls through to numeric', () => {
    const s = new StubValue(1);
    expect(s.binaryOp('+', new StubValue(2))).toBe(NO_OP);
    expect(s.binaryOp('-', 5)).toBe(NO_OP);
  });

  test('equals() is symmetric across two construction paths', () => {
    const a = new StubValue(42);
    const b = new StubValue(42);
    expect(a === b).toBe(false);          // distinct instances
    expect(a.equals(b)).toBe(true);       // value-equal
    expect(b.equals(a)).toBe(true);       // symmetric
  });

  test('NO_OP is a registered symbol — survives module duplication', () => {
    // Symbol.for("...") returns the same symbol from the global registry,
    // so even if base.ts loads under two specifiers, NO_OP === NO_OP.
    expect(NO_OP).toBe(Symbol.for('pyric.RulesValue.NO_OP') as typeof NO_OP);
  });
});
