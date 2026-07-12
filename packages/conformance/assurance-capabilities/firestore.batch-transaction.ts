import type { AssuranceCapabilityRecord } from './types.ts';

/** Atomicity is an authorization surface: a batch is allowed only if every
 *  write in it is allowed, and a transaction re-evaluates on retry against the
 *  re-read state. */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Atomic multi-write batches, transaction retries, and contention behavior.',
  dependencies: [
    { kind: 'construct', id: 'firestore.rule-kind.allow-write' },
    {
      kind: 'unbacked',
      behavior: 'authorization of an atomic multi-write commit as one unit, including transaction retry re-evaluation and contention',
      reason:
        'no rules-language construct models cross-write atomicity and no rules-engine registry row adjudicates commit-level (as opposed to per-write) authorization against production',
    },
  ],
};
