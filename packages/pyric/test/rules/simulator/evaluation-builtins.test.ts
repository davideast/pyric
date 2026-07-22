import { describe, expect, test } from 'bun:test';
import { evaluateFunctionCall } from '../../../src/rules/simulator/evaluation-builtins.js';
import type { SimulationContext } from '../../../src/rules/simulator/evaluation-context.js';

describe('evaluation built-ins', () => {
  test('converts a strict numeric string with int()', () => {
    const literal = { type: 'literal' as const, value: '42', raw: "'42'" };
    expect(evaluateFunctionCall('int', [literal], {} as SimulationContext, {})).toBe(42);
  });
});
