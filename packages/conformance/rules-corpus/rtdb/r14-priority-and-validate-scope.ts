/**
 * ─── r14-priority-and-validate-scope ──────────────────────────────────────
 * Two RTDB behaviors that only a real deploy can settle.
 *
 * PRIORITY. `/docs/$docId` accepts a document only while its write carries NO
 * priority (`newData.getPriority() === null`) — the ordinary case for a plain
 * `set()`. `/ranked` is the mirror image: it requires a priority
 * (`getPriority() !== null`), which a plain `set()` never carries, so every
 * write to it denies. Production settles both directions of `getPriority()`.
 *
 * VALIDATE SCOPE. `/docs/$docId` carries a `.validate` demanding `title` and
 * `body`. A write to `/docs/$docId/meta/$key` — DEEPER than that node — is
 * DENIED by production: the ancestor's `.validate` IS evaluated, against the
 * merged post-write value at the ancestor (`{meta: {...}}`, which has neither
 * child). The scenario was authored expecting an ALLOW on the reasoning that
 * `.validate` "does not cascade"; production said DENY and production won.
 * r15-validate-ancestor-scope isolates the semantic on a minimal ruleset, and
 * the SIMULATOR DIVERGES here — it evaluates `.validate` only from the write
 * location downward, so it allows this write. The divergence is pinned in
 * packages/pyric/test/database/rules-conformance.test.ts KNOWN_DIVERGENCES.
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture
 * (observations/rtdb-rules/rules-rtdb-r14-priority-and-validate-scope.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'getPriority() in both directions (a plain set carries no priority, so the priority-required node denies every write) and the scope of .validate (an ancestor .validate DOES govern a write to a node beneath it — production denies, the simulator allows).',
  provenance:
    'Authored to exercise the rtdb snapshot method `getPriority()` and to probe the scope of .validate, then captured against the live oracle database; expectations are the captured production verdicts, including the deep-write DENY that contradicted the authored ALLOW and led to r15-validate-ancestor-scope.',
  rules: JSON.stringify({
    docs: {
      $docId: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        '.validate': "newData.getPriority() === null && newData.hasChildren(['title', 'body'])",
        meta: {
          $key: {
            '.write': 'auth != null',
            '.validate': 'newData.isString()',
          },
        },
      },
    },
    ranked: {
      '.read': 'auth != null',
      '.write': 'auth != null && newData.getPriority() !== null',
    },
  }),
  cases: [
    {
      description: 'unprioritized document allowed (getPriority is null)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/docs/d1',
      authPresent: true,
      newData: { title: 't', body: 'b' },
    },
    {
      description: 'document missing body denied (ancestor validate at the write location)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/docs/d2',
      authPresent: true,
      newData: { title: 't' },
    },
    {
      description: 'write beneath the validated node denied (the ancestor .validate is evaluated)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/docs/d3/meta/tag',
      authPresent: true,
      newData: 'draft',
    },
    {
      description: 'write beneath the validated node still meets its own validate',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/docs/d4/meta/tag',
      authPresent: true,
      newData: 7,
    },
    {
      description: 'priority-required node denies a plain write (getPriority is null)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/ranked',
      authPresent: true,
      newData: { v: 1 },
    },
    { description: 'document read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/docs/d1', authPresent: true },
  ],
};
