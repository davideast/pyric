import type { AssuranceCapabilityRecord } from './types.ts';

/** Cross-write visibility inside a batch/transaction: production exposes the
 *  post-write state of OTHER documents in the same commit through
 *  `getAfter()`/`existsAfter()`. */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Cross-write getAfter visibility in batches and transactions.',
  dependencies: [
    { kind: 'construct', id: 'firestore.function.getAfter' },
    { kind: 'construct', id: 'firestore.function.existsAfter' },
    { kind: 'registry-row', id: 'firestore-rules#164' },
  ],
};
