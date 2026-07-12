import type { AssuranceCapabilityRecord } from './types.ts';

/** A multi-path `update()` is one atomic write in production: every `.write`
 *  and `.validate` rule sees ONE projected future tree containing all the
 *  children. Checking each child independently authorizes a write production
 *  would refuse (or refuses one production would allow). */
export const capability: AssuranceCapabilityRecord = {
  service: 'rtdb',
  description: 'Multi-child updates evaluated against one atomic projected tree.',
  dependencies: [
    { kind: 'construct', id: 'rtdb.rule-kind.write' },
    { kind: 'construct', id: 'rtdb.rule-kind.validate' },
    { kind: 'construct', id: 'rtdb.binding.newData' },
    {
      kind: 'unbacked',
      behavior: 'one projected future tree shared by every rule a multi-path update touches',
      reason:
        'atomicity across a multi-child update is not a language construct and no registry row adjudicates whole-update (as opposed to per-leaf) evaluation against production',
    },
  ],
};
