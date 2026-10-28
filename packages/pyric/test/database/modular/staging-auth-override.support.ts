/**
 * Replays the `rtdb-modular-staging-auth-override` observation through the
 * sandbox's RTDB rules simulator: each case's identity, as the rules `auth`
 * variable, writing to its rule-gated path, against the verdict production
 * gave when the same object was the request's auth override.
 *
 * `pyric verify --engine staging` sends `rtdbAuthVariable(auth)` as the
 * override, which derives `auth.provider` from
 * `auth.token.firebase.sign_in_provider`. Two of the observation's identities
 * (`flip_provider`, `flip_sign_in_provider`) carry a `provider` that differs
 * from that claim, recorded to show production reads `provider` from the
 * override verbatim. The engine never sends such an object and the sandbox
 * derives `provider`, so their `provider` field is not compared; their other
 * fields are.
 */
import { compileRtdbRules, simulateRtdbRules } from '../../../src/rules/internal/rtdb.js';

interface OverrideCase {
  mechanism: string;
  identity: string;
  field: string;
  expected: string;
  observed: string;
}

interface OverrideBehavior {
  rules: { rules: Record<string, unknown> };
  identities: { match: Identity; mismatch: Identity; flips: Record<string, Identity> };
  cases: OverrideCase[];
}

type Identity = { uid: string; provider?: string; token?: Record<string, unknown> };

/** Whether an identity's `provider` is the one its sign-in claim implies, as the engine always sends. */
export function providerFollowsClaim(identity: Identity | null): boolean {
  if (identity === null) return true;
  const firebase = (identity.token?.firebase ?? {}) as { sign_in_provider?: unknown };
  return identity.provider === undefined || identity.provider === firebase.sign_in_provider;
}

/** Each compared case where the sandbox simulator's verdict differs from production's, as `identity field`. */
export function stagingAuthOverrideMismatches(behavior: OverrideBehavior): { compared: number; mismatches: string[] } {
  const compiled = compileRtdbRules(behavior.rules);
  const identities: Record<string, Identity | null> = {
    match: behavior.identities.match,
    mismatch: behavior.identities.mismatch,
    null: null,
    ...behavior.identities.flips,
  };
  const mismatches: string[] = [];
  let compared = 0;
  for (const testCase of behavior.cases) {
    if (testCase.mechanism !== 'rest' || testCase.identity === 'admin-no-override') continue;
    const identity = identities[testCase.identity];
    if (identity === undefined) continue;
    // Only `auth.provider` can differ for an identity whose provider is not the
    // one its claim implies; every other field is compared.
    if (testCase.field === 'provider' && !providerFollowsClaim(identity)) continue;
    const result = simulateRtdbRules(compiled, {
      operation: 'write',
      path: `/probe/${testCase.field}/rest_${testCase.identity}`,
      auth: identity === null ? null : { uid: identity.uid, token: identity.token ?? {} },
      mockData: {},
      newData: 'v',
      now: Date.parse('2026-10-23T17:57:00Z'),
    });
    if (!result.success) {
      mismatches.push(`${testCase.identity} ${testCase.field}: simulator error ${result.error.message}`);
      continue;
    }
    compared += 1;
    const sandbox = result.data.allowed ? 'ALLOW' : 'DENY';
    if (sandbox !== testCase.observed) mismatches.push(`${testCase.identity} ${testCase.field}: production ${testCase.observed}, sandbox ${sandbox}`);
  }
  return { compared, mismatches };
}
