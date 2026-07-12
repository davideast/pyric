/**
 * ─── r1-auth-only ─────────────────────────────────────────────────────────
 * The baseline auth gate: `.read` / `.write` require `auth != null`. Authed
 * ops allow; anonymous (signed-out) ops deny. Decomposed from ruleset
 * `r1-auth-only` of the frozen agreement observation; expectations are the
 * production verdicts that observation recorded.
 */
import type { RtdbPackRecord } from './types.ts';

export const pack: RtdbPackRecord = {
  fm: 'rtdb#71',
  rationale: 'auth != null gate — production allows authed read/write and denies anonymous read/write; the simulator must agree.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r1-auth-only. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    '.write': 'auth != null',
  }),
  cases: [
    { description: 'authed read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/value', authPresent: true },
    { description: 'authed write allowed', expectation: 'ALLOW', operation: 'write', opPath: '/value', authPresent: true, newData: { hi: 1 } },
    { description: 'anon read denied', expectation: 'DENY', operation: 'read', opPath: '/value', authPresent: false },
    { description: 'anon write denied', expectation: 'DENY', operation: 'write', opPath: '/value', authPresent: false, newData: { hi: 1 } },
  ],
};
