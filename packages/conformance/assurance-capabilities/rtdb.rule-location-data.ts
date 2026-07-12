import type { AssuranceCapabilityRecord } from './types.ts';

/** In production, `data`/`newData` inside a rule are bound to the RULE's
 *  location, not the written location, and `newData` at an ancestor is the
 *  merged future tree. A write is authorized against that projection. */
export const capability: AssuranceCapabilityRecord = {
  service: 'rtdb',
  description: 'Ancestor data/newData bindings and merged future-tree semantics.',
  dependencies: [
    { kind: 'construct', id: 'rtdb.binding.data' },
    { kind: 'construct', id: 'rtdb.binding.newData' },
    { kind: 'construct', id: 'rtdb.binding.root' },
    { kind: 'construct', id: 'rtdb.semantic.write-cascade' },
    { kind: 'construct', id: 'rtdb.semantic.validate-non-cascade' },
    {
      kind: 'unbacked',
      behavior: '`data`/`newData` bound to an ANCESTOR rule location, with `newData` as the merged future tree of the whole write',
      reason:
        'the snapshot enumerates the data/newData bindings but not their rule-location binding or future-tree projection, and no registry row adjudicates ancestor-location binding against production',
    },
  ],
};
