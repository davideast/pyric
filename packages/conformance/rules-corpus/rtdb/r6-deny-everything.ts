/**
 * ─── r6-deny-everything ───────────────────────────────────────────────────
 * The deny-all baseline: `.read: false` / `.write: false`. Every op denies,
 * authed or anonymous, read or write. Decomposed from ruleset
 * `r6-deny-everything`; every recorded production verdict is DENY.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'literal .read/.write: false denies every op — production denies authed and anonymous read/write; the simulator must deny all.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r6-deny-everything. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    '.read': false,
    '.write': false,
  }),
  cases: [
    { description: 'authed read denied', expectation: 'DENY', operation: 'read', opPath: '/anything', authPresent: true },
    { description: 'authed write denied', expectation: 'DENY', operation: 'write', opPath: '/anything', authPresent: true, newData: { v: 1 } },
    { description: 'anon read denied', expectation: 'DENY', operation: 'read', opPath: '/anything', authPresent: false },
  ],
};
