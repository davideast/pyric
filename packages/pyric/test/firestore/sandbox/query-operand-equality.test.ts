import { describe, expect, test } from 'bun:test';
import {
  captureQueryOperand,
  capturedQueryOperandsEqual,
} from '../../../src/firestore/sandbox/query-operand-equality.js';

describe('captured query operand equality', () => {
  test('compares nested Firestore maps and arrays structurally', () => {
    const left = captureQueryOperand({ a: 1, nested: ['x', { enabled: true }] });
    const same = captureQueryOperand({ nested: ['x', { enabled: true }], a: 1 });
    const changed = captureQueryOperand({ a: 1, nested: ['x', { enabled: false }] });

    expect(capturedQueryOperandsEqual(left, same)).toBe(true);
    expect(capturedQueryOperandsEqual(left, changed)).toBe(false);
  });

  test('falls back to identity when construction cannot snapshot an operand', () => {
    const opaque = new Proxy({}, { ownKeys: () => { throw new Error('opaque'); } });
    const other = new Proxy({}, { ownKeys: () => { throw new Error('opaque'); } });

    expect(capturedQueryOperandsEqual(captureQueryOperand(opaque), captureQueryOperand(opaque))).toBe(true);
    expect(capturedQueryOperandsEqual(captureQueryOperand(opaque), captureQueryOperand(other))).toBe(false);
  });
});
