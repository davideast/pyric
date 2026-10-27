import { describe, expect, it } from 'bun:test';

import { rtdbAuthVariable } from '../../../src/rules/internal/rtdb.js';
import { load } from './oracle-conformance.support.js';
import { providerFollowsClaim, stagingAuthOverrideMismatches } from './staging-auth-override.support.js';

const behavior = load('rtdb-modular-staging-auth-override.json') as Parameters<typeof stagingAuthOverrideMismatches>[0] & {
  allMatchExpectation: boolean;
  invariants: { rulesRestored: boolean; dataRemoved: boolean };
};

describe('oracle conformance (rtdb-modular): staging auth override', () => {
  it('was captured cleanly: every case as expected, the instance restored', () => {
    expect(behavior.allMatchExpectation).toBe(true);
    expect(behavior.invariants).toEqual({ rulesRestored: true, dataRemoved: true });
  });

  it('the sandbox simulator decides each override identity as production did', () => {
    const { compared, mismatches } = stagingAuthOverrideMismatches(behavior);
    expect(mismatches).toEqual([]);
    // 10 identities over 8 fields, less the provider field of the two identities whose provider is not their claim's.
    expect(compared).toBe(10 * 8 - 2);
  });

  it('the override the staging engine sends always carries the provider its sign-in claim implies', () => {
    const auth = { uid: 'alice', token: { email: 'alice@example.com', firebase: { sign_in_provider: 'password', tenant: 'tenant-a' } } };
    const override = rtdbAuthVariable(auth, Date.parse('2026-10-23T17:57:00Z')) as unknown as Parameters<typeof providerFollowsClaim>[0];
    expect(override).toMatchObject({ uid: 'alice', provider: 'password', token: { email: 'alice@example.com', firebase: { sign_in_provider: 'password', tenant: 'tenant-a' } } });
    expect(providerFollowsClaim(override)).toBe(true);
  });
});
