import { describe, expect, it } from 'bun:test';
import { activityStructuralIdentity } from '../../../src/firestore/sandbox/activity-structural-identity.js';

describe('activityStructuralIdentity', () => {
  it('canonicalizes trusted activity maps independently of key order', () => {
    expect(activityStructuralIdentity({ b: 2, a: [1, true] })).toBe(
      activityStructuralIdentity({ a: [1, true], b: 2 }),
    );
  });

  it('distinguishes nested query and actor/auth values', () => {
    expect(activityStructuralIdentity({ filters: [{ value: 'open' }] })).not.toBe(
      activityStructuralIdentity({ filters: [{ value: 'closed' }] }),
    );
    expect(activityStructuralIdentity({ actor: { kind: 'app' }, uid: 'alice' })).not.toBe(
      activityStructuralIdentity({ actor: { kind: 'app' }, uid: 'bob' }),
    );
  });
});
