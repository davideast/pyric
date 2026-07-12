import type { AssuranceCapabilityRecord } from './types.ts';

/** Transaction retries re-run the rules against the re-read state, push-key
 *  allocation decides the path a write is authorized at, and listeners
 *  re-evaluate `.read` on every event delivery. */
export const capability: AssuranceCapabilityRecord = {
  service: 'rtdb',
  description: 'Transaction retries, push-key allocation, and listener re-evaluation are not probe operations in v1.',
  dependencies: [
    { kind: 'construct', id: 'rtdb.rule-kind.read' },
    { kind: 'construct', id: 'rtdb.rule-kind.write' },
    {
      kind: 'unbacked',
      behavior: 'rules re-evaluation on transaction retry, on push-key allocation, and on every listener event delivery',
      reason:
        'none of the three is a language construct, and no registry row adjudicates re-authorization on retry or on listener delivery against production',
    },
  ],
};
