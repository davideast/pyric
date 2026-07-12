/**
 * ─── r5-cascade-root-grant ────────────────────────────────────────────────
 * Read cascade: `.read: true` at the subtree root grants EVERY descendant read
 * (authed and anonymous), even where a deeper node sets `.write: false`. Writes
 * still require the root `.write: auth != null`, and the deeper `.write: false`
 * does NOT revoke the ancestor write grant (cascade is grant-only, deeper
 * `false` cannot override a truthy ancestor). Decomposed from ruleset
 * `r5-cascade-root-grant`; every recorded production verdict is ALLOW.
 */
import type { RtdbPackRecord } from './types.ts';

export const pack: RtdbPackRecord = {
  fm: 'rtdb#71',
  rationale: 'root .read: true cascades to all descendants and a deeper .write: false cannot revoke an ancestor .write grant — production allows every op; the simulator must model grant-only cascade.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r5-cascade-root-grant. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    '.read': true,
    '.write': 'auth != null',
    inner: {
      '.write': false,
    },
  }),
  cases: [
    { description: 'cascade allows deep read', expectation: 'ALLOW', operation: 'read', opPath: '/inner/deep', authPresent: true },
    { description: 'cascade allows anon deep read (true)', expectation: 'ALLOW', operation: 'read', opPath: '/inner/deep', authPresent: false },
    { description: 'deeper false override write denied (BUT cascade from auth grant?)', expectation: 'ALLOW', operation: 'write', opPath: '/inner/deep', authPresent: true, newData: { v: 1 } },
    { description: 'top-level write allowed (auth)', expectation: 'ALLOW', operation: 'write', opPath: '/top', authPresent: true, newData: { v: 1 } },
  ],
};
