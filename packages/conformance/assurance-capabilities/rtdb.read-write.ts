import type { AssuranceCapabilityRecord } from './types.ts';

/** The RTDB authorization path for a single-location read or write: the
 *  read/write cascade, deny-by-default, the auth bindings, and the snapshot
 *  methods a `.read`/`.write` expression calls. */
export const capability: AssuranceCapabilityRecord = {
  service: 'rtdb',
  description: 'Rules-respecting get, set, single-child update, and remove operations.',
  dependencies: [
    { kind: 'construct', id: 'rtdb.rule-kind.read' },
    { kind: 'construct', id: 'rtdb.rule-kind.write' },
    { kind: 'construct', id: 'rtdb.rule-kind.location-wildcard' },
    { kind: 'construct', id: 'rtdb.binding.auth' },
    { kind: 'construct', id: 'rtdb.binding.auth.uid' },
    { kind: 'construct', id: 'rtdb.binding.auth.token' },
    { kind: 'construct', id: 'rtdb.binding.path-variable' },
    { kind: 'construct', id: 'rtdb.method.snapshot.val' },
    { kind: 'construct', id: 'rtdb.method.snapshot.child' },
    { kind: 'construct', id: 'rtdb.method.snapshot.exists' },
    { kind: 'construct', id: 'rtdb.operator.strictEq' },
    { kind: 'construct', id: 'rtdb.operator.and' },
    { kind: 'construct', id: 'rtdb.operator.or' },
    { kind: 'construct', id: 'rtdb.operator.not' },
    { kind: 'construct', id: 'rtdb.semantic.read-cascade' },
    { kind: 'construct', id: 'rtdb.semantic.write-cascade' },
    { kind: 'construct', id: 'rtdb.semantic.deny-by-default' },
  ],
};
