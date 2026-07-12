import type { AssuranceCapabilityRecord } from './types.ts';

/** A resumable upload authorizes at session creation AND on each chunk, and a
 *  paginated list authorizes the whole prefix, not the page. */
export const capability: AssuranceCapabilityRecord = {
  service: 'storage',
  description: 'Resumable transfer state and paginated list semantics are not probe operations in v1.',
  dependencies: [
    { kind: 'construct', id: 'storage.rule-kind.allow-list' },
    {
      kind: 'unbacked',
      behavior: 'authorization of resumable-upload session state across chunks, and of a paginated list against its prefix',
      reason:
        'neither is a language construct, and no registry row adjudicates resumable-session or pagination authorization against production',
    },
  ],
};
