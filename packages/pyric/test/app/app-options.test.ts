import { describe, expect, it } from 'bun:test';
import { firebaseOptionsEqual } from '../../src/app/internal.ts';

describe('Firebase options equality', () => {
  it('is one recursive contract for page and worker configuration locks', () => {
    expect(firebaseOptionsEqual(
      { projectId: 'demo', nested: { flags: [true, { value: 1 }] } },
      { nested: { flags: [true, { value: 1 }] }, projectId: 'demo' },
    )).toBe(true);
    expect(firebaseOptionsEqual(
      { projectId: 'demo', nested: { flags: [true, { value: 1 }] } },
      { projectId: 'demo', nested: { flags: [true, { value: 2 }] } },
    )).toBe(false);
  });
});
