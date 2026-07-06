import { describe, expect, test } from 'bun:test';

import { applyAuthSeedUsers } from './seed-auth-apply';

describe('applyAuthSeedUsers', () => {
  test('creates users and collects per-entry errors', () => {
    const result = applyAuthSeedUsers([
      { uid: 'seed-auth-a', email: 'a@test.dev', password: 'pw-a-123' },
      { uid: 'seed-auth-b', email: 'b@test.dev', password: 'pw-b-123' },
    ]);
    expect(result.created).toContain('seed-auth-a');
    expect(result.created).toContain('seed-auth-b');

    const dup = applyAuthSeedUsers([{ uid: 'seed-auth-a' }]);
    expect(dup.failed).toBe(1);
    expect(dup.created).toHaveLength(0);
  });

  test('rejects batches over cap', () => {
    const users = Array.from({ length: 101 }, (_, i) => ({ uid: `cap-${i}` }));
    const result = applyAuthSeedUsers(users);
    expect(result.created).toHaveLength(0);
    expect(result.failed).toBe(101);
  });
});
