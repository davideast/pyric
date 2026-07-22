import { describe, expect, test } from 'bun:test';
import {
  captureQueryOperand,
  capturedQueryOperandsEqual,
} from '../../../src/firestore/sandbox/query-operand-equality.js';
import { Timestamp } from '../../../src/firestore/sandbox/admin-compat/types.js';

describe('captured query operand equality', () => {
  test('compares nested Firestore maps and arrays structurally', () => {
    const left = captureQueryOperand({ a: 1, nested: ['x', { enabled: true }] });
    const same = captureQueryOperand({ nested: ['x', { enabled: true }], a: 1 });
    const changed = captureQueryOperand({ a: 1, nested: ['x', { enabled: false }] });

    expect(capturedQueryOperandsEqual(left, same)).toBe(true);
    expect(capturedQueryOperandsEqual(left, changed)).toBe(false);
  });

  test('rejects values that Firebase cannot use as query operands', () => {
    const opaque = new Proxy({}, { ownKeys: () => { throw new Error('opaque'); } });

    for (const value of [undefined, BigInt(1), () => undefined, opaque]) {
      expect(() => captureQueryOperand(value)).toThrow();
      try {
        captureQueryOperand(value);
      } catch (error) {
        expect((error as { code?: unknown }).code).toBe('invalid-argument');
      }
    }
  });

  test('rejects direct nested arrays while allowing arrays below a map boundary', () => {
    expect(() => captureQueryOperand([[1]])).toThrow();
    expect(() => captureQueryOperand({ nested: [[1]] })).toThrow();
    expect(() => captureQueryOperand([{ nested: [1] }])).not.toThrow();
    expect(() => captureQueryOperand({ nested: [{ values: [1] }] })).not.toThrow();
    expect(() => captureQueryOperand([[[1]]], undefined, true)).not.toThrow();
  });

  test('preserves numeric signs and normalizes Date to Timestamp', () => {
    expect(capturedQueryOperandsEqual(captureQueryOperand(-0), captureQueryOperand(0))).toBe(false);
    expect(capturedQueryOperandsEqual(
      captureQueryOperand(new Date(1_234)),
      captureQueryOperand(Timestamp.fromMillis(1_234)),
    )).toBe(true);
  });
});
