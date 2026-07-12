import type { AssuranceCapabilityRecord } from './types.ts';

/** Rules-respecting single-document reads and writes: the authorization path a
 *  document probe walks (match resolution, request/resource bindings, the allow
 *  verbs, boolean composition). Deliberately excludes `get()`/`exists()`
 *  cross-document lookups, query proof, and post-write bindings — those are
 *  separate capabilities. */
export const capability: AssuranceCapabilityRecord = {
  service: 'firestore',
  description: 'Rules-respecting get, create, set, merge, update, and delete operations.',
  dependencies: [
    { kind: 'construct', id: 'firestore.rule-kind.match' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-read' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-write' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-get' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-create' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-update' },
    { kind: 'construct', id: 'firestore.rule-kind.allow-delete' },
    { kind: 'construct', id: 'firestore.binding.request' },
    { kind: 'construct', id: 'firestore.binding.request.auth' },
    { kind: 'construct', id: 'firestore.binding.request.auth.uid' },
    { kind: 'construct', id: 'firestore.binding.request.auth.token' },
    { kind: 'construct', id: 'firestore.binding.request.resource' },
    { kind: 'construct', id: 'firestore.binding.request.resource.data' },
    { kind: 'construct', id: 'firestore.binding.request.method' },
    { kind: 'construct', id: 'firestore.binding.resource' },
    { kind: 'construct', id: 'firestore.binding.resource.data' },
    { kind: 'construct', id: 'firestore.binding.path-variable' },
    { kind: 'construct', id: 'firestore.operator.eq' },
    { kind: 'construct', id: 'firestore.operator.neq' },
    { kind: 'construct', id: 'firestore.operator.and' },
    { kind: 'construct', id: 'firestore.operator.or' },
    { kind: 'construct', id: 'firestore.operator.not' },
    { kind: 'construct', id: 'firestore.operator.member' },
    { kind: 'construct', id: 'firestore.operator.in' },
    { kind: 'construct', id: 'firestore.semantic.hierarchical-match-cascade' },
    { kind: 'construct', id: 'firestore.semantic.recursive-wildcard' },
    { kind: 'construct', id: 'firestore.semantic.error-absorption-and' },
    { kind: 'construct', id: 'firestore.semantic.error-absorption-or' },
  ],
};
