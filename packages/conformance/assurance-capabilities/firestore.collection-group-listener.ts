import type { AssuranceCapabilityRecord } from './types.ts';

/** Collection-group queries authorize against a `{document=**}`-scoped match
 *  across every collection with the same id, and listeners re-evaluate rules on
 *  every snapshot delivery, not only at attach time. */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Collection-group authorization and listener re-evaluation are not probe operations in v1.',
  dependencies: [
    { kind: 'construct', id: 'firestore.rule-kind.allow-list' },
    { kind: 'construct', id: 'firestore.semantic.recursive-wildcard' },
    {
      kind: 'unbacked',
      behavior: 'collection-group match scoping and rules re-evaluation on every listener snapshot delivery',
      reason:
        'neither is a language construct, and no registry row adjudicates collection-group match scope or listener re-authorization against production',
    },
  ],
};
