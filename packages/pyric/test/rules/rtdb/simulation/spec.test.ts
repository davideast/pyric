import { describe, test, expect } from 'bun:test';
import {
  SimulateErrorCode,
  SimulationInputSchema,
  simulationQueryProblem,
} from '../../../../src/rules/rtdb/simulation/spec.js';

test('simulation errors do not expose a generate-before-simulate lifecycle', () => {
  expect(SimulateErrorCode.options).toEqual([
    'INVALID_INPUT',
    'NO_MATCHING_RULE',
    'EVALUATION_ERROR',
  ]);
});

const BASE = {
  operation: 'read' as const,
  path: '/users/alice',
  auth: null,
  mockData: {},
};

describe('SimulationInputSchema', () => {
  test('accepts valid input', () => {
    const result = SimulationInputSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  test('rejects path not starting with /', () => {
    const result = SimulationInputSchema.safeParse({ ...BASE, path: 'users/alice' });
    expect(result.success).toBe(false);
  });

  test('rejects empty path', () => {
    const result = SimulationInputSchema.safeParse({ ...BASE, path: '' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid operation', () => {
    const result = SimulationInputSchema.safeParse({ ...BASE, operation: 'delete' });
    expect(result.success).toBe(false);
  });

  test('accepts write operation', () => {
    const result = SimulationInputSchema.safeParse({ ...BASE, operation: 'write', newData: { name: 'Alice' } });
    expect(result.success).toBe(true);
  });

  test('accepts validate operation', () => {
    const result = SimulationInputSchema.safeParse({ ...BASE, operation: 'validate' });
    expect(result.success).toBe(true);
  });

  test('accepts auth with uid and token', () => {
    const result = SimulationInputSchema.safeParse({
      ...BASE,
      auth: { uid: 'user123', token: { email: 'test@example.com' } },
    });
    expect(result.success).toBe(true);
  });

  test('rejects auth with missing uid', () => {
    const result = SimulationInputSchema.safeParse({
      ...BASE,
      auth: { token: {} },
    });
    expect(result.success).toBe(false);
  });

  test('accepts auth with uid and tenant without token', () => {
    const result = SimulationInputSchema.safeParse({
      ...BASE,
      auth: { uid: 'user123', tenant: 'tenant-a' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts auth with uid, tenant, and token', () => {
    const result = SimulationInputSchema.safeParse({
      ...BASE,
      auth: { uid: 'user123', tenant: 'tenant-a', token: { role: 'admin' } },
    });
    expect(result.success).toBe(true);
  });

  test('accepts auth with only uid (both tenant and token omitted)', () => {
    const result = SimulationInputSchema.safeParse({
      ...BASE,
      auth: { uid: 'user123' },
    });
    expect(result.success).toBe(true);
  });
});

describe('simulationQueryProblem', () => {
  test('rejects conflicting startAt or endAt with equalTo (QRY-3b)', () => {
    expect(
      simulationQueryProblem({ orderByChild: 'status', startAt: 'a', equalTo: 'b' }),
    ).toBe('equalTo: Starting point was already set (by another call to startAt, startAfter, or equalTo).');
    expect(
      simulationQueryProblem({ orderByChild: 'status', endAt: 'a', equalTo: 'b' }),
    ).toBe('equalTo: Ending point was already set (by another call to endAt, endBefore, or equalTo).');
  });

  test('rejects slash-only orderByChild (#1019)', () => {
    expect(simulationQueryProblem({ orderByChild: '/' })).toBe(
      'orderByChild: cannot pass in empty path. Use orderByValue() instead.',
    );
    expect(simulationQueryProblem({ orderByChild: '///' })).toBe(
      'orderByChild: cannot pass in empty path. Use orderByValue() instead.',
    );
  });

  test('accepts orderByPriority and rejects combining it with another orderBy*', () => {
    expect(simulationQueryProblem({ orderByPriority: true })).toBeNull();
    expect(
      simulationQueryProblem({ orderByPriority: true, orderByKey: true }),
    ).toContain('orderBy');
  });

  // CS-7 (#1247): the shapes below are refused by the SDK with the texts
  // capture rtdb-modular-query-construction-validation records.
  const KEY_ENDPOINT =
    'Query: When ordering by key, the argument passed to startAt(), startAfter(), endAt(), endBefore(), or equalTo() must be a string.';
  const PRIORITY =
    'Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string).';
  const PATH_SUFFIX = 'Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"';

  test('CS-7: orderByKey refuses a bound that is not a string (orderByKeyEndpoints)', () => {
    expect(simulationQueryProblem({ orderByKey: true, startAt: 5 })).toBe(KEY_ENDPOINT);
    expect(simulationQueryProblem({ orderByKey: true, endAt: false })).toBe(KEY_ENDPOINT);
    expect(simulationQueryProblem({ orderByKey: true, equalTo: true })).toBe(KEY_ENDPOINT);
    expect(simulationQueryProblem({ orderByKey: true, startAt: 'a', endAt: 'b' })).toBeNull();
  });

  test('CS-7: orderByChild refuses reserved names (orderByChild.reserved)', () => {
    expect(simulationQueryProblem({ orderByChild: '$key' })).toBe('orderByChild: "$key" is invalid.  Use orderByKey() instead.');
    expect(simulationQueryProblem({ orderByChild: '$priority' })).toBe('orderByChild: "$priority" is invalid.  Use orderByPriority() instead.');
    expect(simulationQueryProblem({ orderByChild: '$value' })).toBe('orderByChild: "$value" is invalid.  Use orderByValue() instead.');
  });

  test('CS-7: orderByChild refuses invalid paths (orderByChild.invalid)', () => {
    for (const path of ['', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a\u0000b']) {
      expect(simulationQueryProblem({ orderByChild: path })).toBe(
        `orderByChild failed: path argument was an invalid path = "${path}". ${PATH_SUFFIX}`,
      );
    }
    expect(simulationQueryProblem({ orderByChild: 'a/b' })).toBeNull();
  });

  test('CS-7: default ordering refuses a boolean bound (byIndex.defaultPriority)', () => {
    expect(simulationQueryProblem({ startAt: true })).toBe(PRIORITY);
    expect(simulationQueryProblem({ orderByPriority: true, equalTo: false })).toBe(PRIORITY);
    expect(simulationQueryProblem({ startAt: 1, endAt: 'z' })).toBeNull();
    expect(simulationQueryProblem({ orderByValue: true, startAt: true })).toBeNull();
    expect(simulationQueryProblem({ orderByChild: 'x', equalTo: true })).toBeNull();
  });

  test('a null bound reads as no bound', () => {
    expect(simulationQueryProblem({ orderByKey: true, startAt: null, endAt: null })).toBeNull();
  });
});


