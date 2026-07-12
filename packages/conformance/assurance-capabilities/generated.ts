// GENERATED FILE. Do not edit by hand; run bun run compat:assurance.
//
// The assurance engine's capabilities, DERIVED from the conformance graph by
// packages/conformance/src/assurance-capabilities.ts (see that file's header for
// the derivation rules). The assurance runtime consumes this module directly:
// each record is structurally an AssuranceEngineCapability, and `reasons` carries
// the graph evidence a probe cites when it abstains.
import type { AssuranceCapabilityService, AssuranceCapabilityStatus } from './types.ts';

export interface GeneratedAssuranceCapability {
  id: string;
  service: AssuranceCapabilityService;
  status: AssuranceCapabilityStatus;
  description: string;
  /** The graph evidence that pinned the status: the dependencies whose verdict
   *  equals it. A probe that abstains reports these. */
  reasons: string[];
}

export const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[] = [
  {
    id: "auth.password-anonymous-fixture",
    service: "auth",
    status: "qualified",
    description: "Password, anonymous-account, anonymous-request, fixture-user, and synthetic lenses.",
    reasons: [
      "auth#7: registry row auth#7 (auth) status \"diverged-documented\"; divergence is in an SDK surface: the verdict machinery is sound, the probe setup is not production-identical",
    ],
  },
  {
    id: "auth.provider-token-flows",
    service: "auth",
    status: "unsupported",
    description: "OAuth provider, custom-token, MFA, revocation, and email-action acquisition flows are outside v1.",
    reasons: [
      "auth#49: registry row auth#49 (auth) status \"unsupported\"",
      "custom-token sign-in, MFA enrollment/resolution, refresh-token revocation, and email-action link acquisition: the conformance graph does not model this behavior: the auth registry has no rows for these flows: they are unmirrored surface, so the graph holds no evidence that an actor acquired through them matches production",
    ],
  },
  {
    id: "firestore.batch-get-after",
    service: "firestore",
    status: "unsupported",
    description: "Cross-write getAfter visibility in batches and transactions.",
    reasons: [
      "firestore.function.getAfter: snapshot status \"rejected\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s); covered by rules-engine divergence firestore-rules#164",
      "firestore.function.existsAfter: snapshot status \"rejected\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s); covered by rules-engine divergence firestore-rules#164",
      "firestore-rules#164: registry row firestore-rules#164 (firestore-rules) status \"diverged-documented\"; divergence is in the rules engine itself: the verdict machinery is known wrong here",
    ],
  },
  {
    id: "firestore.batch-transaction",
    service: "firestore",
    status: "unsupported",
    description: "Atomic multi-write batches, transaction retries, and contention behavior.",
    reasons: [
      "authorization of an atomic multi-write commit as one unit, including transaction retry re-evaluation and contention: the conformance graph does not model this behavior: no rules-language construct models cross-write atomicity and no rules-engine registry row adjudicates commit-level (as opposed to per-write) authorization against production",
    ],
  },
  {
    id: "firestore.collection-group-listener",
    service: "firestore",
    status: "unsupported",
    description: "Collection-group authorization and listener re-evaluation are not probe operations in v1.",
    reasons: [
      "collection-group match scoping and rules re-evaluation on every listener snapshot delivery: the conformance graph does not model this behavior: neither is a language construct, and no registry row adjudicates collection-group match scope or listener re-authorization against production",
    ],
  },
  {
    id: "firestore.crud",
    service: "firestore",
    status: "supported",
    description: "Rules-respecting get, create, set, merge, update, and delete operations.",
    reasons: [
      "firestore.rule-kind.match: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 23 captured scenario(s)",
      "firestore.rule-kind.allow-read: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "firestore.rule-kind.allow-write: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.rule-kind.allow-get: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.rule-kind.allow-create: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 20 captured scenario(s)",
      "firestore.rule-kind.allow-update: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "firestore.rule-kind.allow-delete: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.binding.request: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 22 captured scenario(s)",
      "firestore.binding.request.auth: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 18 captured scenario(s)",
      "firestore.binding.request.auth.uid: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.binding.request.auth.token: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "firestore.binding.request.resource: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 14 captured scenario(s)",
      "firestore.binding.request.resource.data: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 14 captured scenario(s)",
      "firestore.binding.request.method: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.binding.resource: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "firestore.binding.resource.data: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.binding.path-variable: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 23 captured scenario(s)",
      "firestore.operator.eq: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 16 captured scenario(s)",
      "firestore.operator.neq: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 17 captured scenario(s)",
      "firestore.operator.and: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 19 captured scenario(s)",
      "firestore.operator.or: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 4 captured scenario(s)",
      "firestore.operator.not: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 5 captured scenario(s)",
      "firestore.operator.member: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 23 captured scenario(s)",
      "firestore.operator.in: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "firestore.semantic.hierarchical-match-cascade: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 23 captured scenario(s)",
      "firestore.semantic.recursive-wildcard: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.semantic.error-absorption-and: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "firestore.semantic.error-absorption-or: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
    ],
  },
  {
    id: "firestore.overlapping-match-or",
    service: "firestore",
    status: "unsupported",
    description: "Multiple matching allow blocks with production OR composition.",
    reasons: [
      "OR composition across multiple allow-bearing match blocks that match the same path: the conformance graph does not model this behavior: the language snapshot enumerates the hierarchical-match cascade (parent/child nesting) but has no construct for multi-block OR composition, and no rules-engine registry row adjudicates it against the production Rules Test API",
    ],
  },
  {
    id: "firestore.query-equality",
    service: "firestore",
    status: "unsupported",
    description: "Collection queries whose rules proof uses the supported equality subset.",
    reasons: [
      "firestore.binding.request.query: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s); covered by rules-engine divergence firestore-rules#166",
      "firestore-rules#166: registry row firestore-rules#166 (firestore-rules) status \"diverged-documented\"; divergence is in the rules engine itself: the verdict machinery is known wrong here",
    ],
  },
  {
    id: "rtdb.atomic-multipath",
    service: "rtdb",
    status: "unsupported",
    description: "Multi-child updates evaluated against one atomic projected tree.",
    reasons: [
      "one projected future tree shared by every rule a multi-path update touches: the conformance graph does not model this behavior: atomicity across a multi-child update is not a language construct and no registry row adjudicates whole-update (as opposed to per-leaf) evaluation against production",
    ],
  },
  {
    id: "rtdb.query",
    service: "rtdb",
    status: "unsupported",
    description: "Local ordering, bounds, equality, and limits; index enforcement is not modeled.",
    reasons: [
      "query constraints (orderBy/startAt/endAt/equalTo/limit) visible to a `.read` expression, and index enforcement rejecting an unindexed query: the conformance graph does not model this behavior: the RTDB language snapshot enumerates no query bindings, so the constraints a production `.read` rule can authorize against are not modeled by any construct, and no registry row adjudicates query-shape authorization",
    ],
  },
  {
    id: "rtdb.read-write",
    service: "rtdb",
    status: "qualified",
    description: "Rules-respecting get, set, single-child update, and remove operations.",
    reasons: [
      "rtdb.rule-kind.read: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 8 captured scenario(s)",
      "rtdb.rule-kind.write: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 8 captured scenario(s)",
      "rtdb.rule-kind.location-wildcard: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "rtdb.binding.auth: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 7 captured scenario(s)",
      "rtdb.binding.auth.uid: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "rtdb.binding.auth.token: snapshot status \"unprobed\"; capability probe \"implemented\"; no production-captured scenario and no conforming oracle-backed row verifies it",
      "rtdb.binding.path-variable: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "rtdb.method.snapshot.val: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "rtdb.method.snapshot.child: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "rtdb.method.snapshot.exists: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "rtdb.operator.strictEq: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "rtdb.operator.and: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "rtdb.operator.or: snapshot status \"unprobed\"; capability probe \"implemented\"; no production-captured scenario and no conforming oracle-backed row verifies it",
      "rtdb.operator.not: snapshot status \"unprobed\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "rtdb.semantic.read-cascade: snapshot status \"unprobed\"; capability probe \"implemented\"; no production-captured scenario and no conforming oracle-backed row verifies it",
      "rtdb.semantic.write-cascade: snapshot status \"unprobed\"; capability probe \"implemented\"; no production-captured scenario and no conforming oracle-backed row verifies it",
      "rtdb.semantic.deny-by-default: snapshot status \"unprobed\"; capability probe \"implemented\"; no production-captured scenario and no conforming oracle-backed row verifies it",
    ],
  },
  {
    id: "rtdb.rule-location-data",
    service: "rtdb",
    status: "unsupported",
    description: "Ancestor data/newData bindings and merged future-tree semantics.",
    reasons: [
      "`data`/`newData` bound to an ANCESTOR rule location, with `newData` as the merged future tree of the whole write: the conformance graph does not model this behavior: the snapshot enumerates the data/newData bindings but not their rule-location binding or future-tree projection, and no registry row adjudicates ancestor-location binding against production",
    ],
  },
  {
    id: "rtdb.transaction-listener",
    service: "rtdb",
    status: "unsupported",
    description: "Transaction retries, push-key allocation, and listener re-evaluation are not probe operations in v1.",
    reasons: [
      "rules re-evaluation on transaction retry, on push-key allocation, and on every listener event delivery: the conformance graph does not model this behavior: none of the three is a language construct, and no registry row adjudicates re-authorization on retry or on listener delivery against production",
    ],
  },
  {
    id: "storage.advanced-rules",
    service: "storage",
    status: "unsupported",
    description: "Granular verbs, functions, time, regex, and Firestore rule lookups.",
    reasons: [
      "storage.binding.resource.timeCreated: snapshot status \"unprobeable\"; capability probe \"unprobeable\"; production-verified by 1 captured scenario(s); covered by rules-engine divergence storage-rules#116",
      "storage.binding.resource.timeUpdated: snapshot status \"unprobeable\"; capability probe \"unprobeable\"; no production-captured scenario and no conforming oracle-backed row verifies it; covered by rules-engine divergence storage-rules#116",
      "storage-rules#116: registry row storage-rules#116 (storage-rules) status \"diverged-documented\"; divergence is in the rules engine itself: the verdict machinery is known wrong here",
    ],
  },
  {
    id: "storage.coarse-rules",
    service: "storage",
    status: "supported",
    description: "Coarse read/write with auth, size, content type, metadata, and path matching.",
    reasons: [
      "storage.rule-kind.match: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 8 captured scenario(s)",
      "storage.rule-kind.allow-read: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "storage.rule-kind.allow-write: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.request: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 7 captured scenario(s)",
      "storage.binding.request.auth: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "storage.binding.request.auth.uid: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "storage.binding.request.auth.token: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.request.resource: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "storage.binding.request.resource.size: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "storage.binding.request.resource.contentType: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 3 captured scenario(s)",
      "storage.binding.request.resource.metadata: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.resource: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 4 captured scenario(s)",
      "storage.binding.resource.size: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.resource.contentType: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.resource.metadata: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.binding.path-variable: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 8 captured scenario(s)",
      "storage.operator.eq: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 5 captured scenario(s)",
      "storage.operator.neq: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "storage.operator.lt: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 4 captured scenario(s)",
      "storage.operator.and: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "storage.operator.or: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.operator.not: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.semantic.read-umbrella: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 2 captured scenario(s)",
      "storage.semantic.write-umbrella: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.semantic.recursive-wildcard: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by 1 captured scenario(s)",
      "storage.semantic.deny-by-default: snapshot status \"accepted\"; capability probe \"implemented\"; production-verified by conforming oracle-backed rules-engine row storage-rules#96",
      "storage-rules#98: registry row storage-rules#98 (storage-rules) status \"conforms\"",
      "storage-rules#99: registry row storage-rules#99 (storage-rules) status \"conforms\"",
      "storage-rules#100: registry row storage-rules#100 (storage-rules) status \"conforms\"",
      "storage-rules#101: registry row storage-rules#101 (storage-rules) status \"conforms\"",
      "storage-rules#102: registry row storage-rules#102 (storage-rules) status \"conforms\"",
      "storage-rules#103: registry row storage-rules#103 (storage-rules) status \"conforms\"",
      "storage-rules#114: registry row storage-rules#114 (storage-rules) status \"conforms\"",
    ],
  },
  {
    id: "storage.resumable-pagination",
    service: "storage",
    status: "unsupported",
    description: "Resumable transfer state and paginated list semantics are not probe operations in v1.",
    reasons: [
      "authorization of resumable-upload session state across chunks, and of a paginated list against its prefix: the conformance graph does not model this behavior: neither is a language construct, and no registry row adjudicates resumable-session or pagination authorization against production",
    ],
  },
];
