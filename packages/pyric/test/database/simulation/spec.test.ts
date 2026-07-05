import { describe, test, expect } from 'bun:test';
import { SimulationInputSchema } from '../../../src/database/simulation/spec.js';

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
});
