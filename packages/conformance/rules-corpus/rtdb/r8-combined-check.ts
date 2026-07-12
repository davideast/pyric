/**
 * ─── r8-combined-check ────────────────────────────────────────────────────
 * A combined `.write` predicate at the subtree root:
 * `auth != null && newData.hasChildren(['owner']) && newData.child('owner').val() === auth.uid`.
 * The ops write to `/item`, ONE LEVEL BELOW the rule node, so `newData` at the
 * rule node is `{ item: {...} }` — `newData.child('owner')` is absent there and
 * `hasChildren(['owner'])` is false. Production therefore DENIES every write
 * (including the "matching owner" case, whose owner field lives under `/item`,
 * not at the rule node), and allows only the auth-gated read. Decomposed from
 * ruleset `r8-combined-check`; expectations are the recorded production
 * verdicts. A worked example that rule placement relative to the written path
 * decides the outcome — the simulator must project `newData` at the same node.
 */
import type { RtdbPackRecord } from './types.ts';

export const pack: RtdbPackRecord = {
  fm: 'rtdb#71',
  rationale: 'a root-level .write predicate reading newData.child(\'owner\') sees {item:{...}} for a write one level deeper, so hasChildren([\'owner\']) is false — production denies all writes; the simulator must project newData at the rule node identically.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r8-combined-check. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    '.write': "auth != null && newData.hasChildren(['owner']) && newData.child('owner').val() === auth.uid",
    '.read': 'auth != null',
  }),
  cases: [
    { description: 'matching owner field allowed', expectation: 'DENY', operation: 'write', opPath: '/item', authPresent: true, newData: { owner: '<UID>', v: 1 } },
    { description: 'wrong owner denied', expectation: 'DENY', operation: 'write', opPath: '/item', authPresent: true, newData: { owner: 'somebody-else', v: 1 } },
    { description: 'missing owner field denied', expectation: 'DENY', operation: 'write', opPath: '/item', authPresent: true, newData: { v: 1 } },
    { description: 'auth-only read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/item', authPresent: true },
  ],
};
