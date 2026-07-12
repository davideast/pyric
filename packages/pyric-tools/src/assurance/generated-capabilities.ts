// GENERATED FILE. Do not edit by hand; run bun run compat:assurance.
//
// The assurance engine's capabilities, DERIVED from the conformance graph by
// packages/conformance/src/assurance-capabilities.ts (see that file's header for
// the derivation rules). This is the assurance runtime's copy: the conformance
// package is private and is NOT a dependency of pyric-tools, so the generator
// emits this self-contained module here rather than have the runtime import it.
//
// A capability status is never authorable. It is derived from the graph, and
// `bun run compat:assurance:check` fails if this file drifts from the graph.
//
// Each dependency carries the FACTS behind its verdict, never a sentence and
// never a count. A probe that abstains renders its reasons on read with
// `capabilityReasons(capability)`; the renderer is emitted below so this
// self-contained copy needs no import to produce the abstention prose.

export type AssuranceCapabilityService = 'firestore' | 'rtdb' | 'storage' | 'auth';
export type AssuranceCapabilityStatus = 'supported' | 'qualified' | 'unsupported';

export type CapabilityVerdict = AssuranceCapabilityStatus;

export interface GeneratedConstructDependency {
  kind: 'construct';
  /** The rules-language construct id. */
  id: string;
  verdict: CapabilityVerdict;
  /** The construct's status in the production language snapshot. */
  snapshot: string;
  /** What the local simulator's capability probe did with it. */
  probe: 'implemented' | 'unsupported' | 'error' | 'unprobeable' | 'absent';
  /** Whether any evidence path compares it against production. A BOOLEAN: how
   *  many scenarios do so is a fact about the corpus, not about this construct. */
  productionVerified: boolean;
  /** Rules-engine rows whose documented divergence names this construct. */
  divergedBy: string[];
}

export interface GeneratedRegistryRowDependency {
  kind: 'registry-row';
  id: string;
  verdict: CapabilityVerdict;
  surface: string;
  status: string;
  rulesEngineSurface: boolean;
}

export interface GeneratedUnbackedDependency {
  kind: 'unbacked';
  /** The behavior the capability needs. */
  id: string;
  verdict: CapabilityVerdict;
  /** Why the graph cannot back it. */
  reason: string;
}

export type GeneratedCapabilityDependency =
  | GeneratedConstructDependency
  | GeneratedRegistryRowDependency
  | GeneratedUnbackedDependency;

export interface GeneratedAssuranceCapability {
  id: string;
  service: AssuranceCapabilityService;
  status: AssuranceCapabilityStatus;
  description: string;
  /** Everything the status rests on. The ones that pinned it are the ones whose
   *  verdict equals the status; `capabilityReasons` selects and renders them. */
  dependencies: GeneratedCapabilityDependency[];
}

export const ASSURANCE_ENGINE_CAPABILITIES: readonly GeneratedAssuranceCapability[] = [
  {
    id: "auth.password-anonymous-fixture",
    service: "auth",
    status: "qualified",
    description: "Password, anonymous-account, anonymous-request, fixture-user, and synthetic lenses.",
    dependencies: [
      {"kind":"registry-row","id":"auth#6","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#7","verdict":"qualified","surface":"auth","status":"diverged-documented","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#8","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#9","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#11","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#13","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#14","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#15","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#16","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#69","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#63","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#73","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#75","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
    ],
  },
  {
    id: "auth.provider-token-flows",
    service: "auth",
    status: "unsupported",
    description: "OAuth provider, custom-token, MFA, revocation, and email-action acquisition flows are outside v1.",
    dependencies: [
      {"kind":"registry-row","id":"auth#44","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#45","verdict":"supported","surface":"auth","status":"conforms","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#48","verdict":"qualified","surface":"auth","status":"diverged-documented","rulesEngineSurface":false},
      {"kind":"registry-row","id":"auth#49","verdict":"unsupported","surface":"auth","status":"unsupported","rulesEngineSurface":false},
      {"kind":"unbacked","id":"custom-token sign-in, MFA enrollment/resolution, refresh-token revocation, and email-action link acquisition","verdict":"unsupported","reason":"the auth registry has no rows for these flows: they are unmirrored surface, so the graph holds no evidence that an actor acquired through them matches production"},
    ],
  },
  {
    id: "firestore.batch-get-after",
    service: "firestore",
    status: "unsupported",
    description: "Cross-write getAfter visibility in batches and transactions.",
    dependencies: [
      {"kind":"construct","id":"firestore.function.getAfter","verdict":"unsupported","snapshot":"rejected","probe":"implemented","productionVerified":true,"divergedBy":["firestore-rules#164"]},
      {"kind":"construct","id":"firestore.function.existsAfter","verdict":"unsupported","snapshot":"rejected","probe":"implemented","productionVerified":true,"divergedBy":["firestore-rules#164"]},
      {"kind":"registry-row","id":"firestore-rules#164","verdict":"unsupported","surface":"firestore-rules","status":"diverged-documented","rulesEngineSurface":true},
    ],
  },
  {
    id: "firestore.batch-transaction",
    service: "firestore",
    status: "unsupported",
    description: "Atomic multi-write batches, transaction retries, and contention behavior.",
    dependencies: [
      {"kind":"construct","id":"firestore.rule-kind.allow-write","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"authorization of an atomic multi-write commit as one unit, including transaction retry re-evaluation and contention","verdict":"unsupported","reason":"no rules-language construct models cross-write atomicity and no rules-engine registry row adjudicates commit-level (as opposed to per-write) authorization against production"},
    ],
  },
  {
    id: "firestore.collection-group-listener",
    service: "firestore",
    status: "unsupported",
    description: "Collection-group authorization and listener re-evaluation are not probe operations in v1.",
    dependencies: [
      {"kind":"construct","id":"firestore.rule-kind.allow-list","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.semantic.recursive-wildcard","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"collection-group match scoping and rules re-evaluation on every listener snapshot delivery","verdict":"unsupported","reason":"neither is a language construct, and no registry row adjudicates collection-group match scope or listener re-authorization against production"},
    ],
  },
  {
    id: "firestore.crud",
    service: "firestore",
    status: "supported",
    description: "Rules-respecting get, create, set, merge, update, and delete operations.",
    dependencies: [
      {"kind":"construct","id":"firestore.rule-kind.match","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-read","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-write","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-get","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-create","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-update","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.allow-delete","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.auth","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.auth.uid","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.auth.token","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.resource","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.resource.data","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.method","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.resource","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.resource.data","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.path-variable","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.eq","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.neq","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.and","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.or","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.not","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.member","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.in","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.semantic.hierarchical-match-cascade","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.semantic.recursive-wildcard","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.semantic.error-absorption-and","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.semantic.error-absorption-or","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
    ],
  },
  {
    id: "firestore.overlapping-match-or",
    service: "firestore",
    status: "unsupported",
    description: "Multiple matching allow blocks with production OR composition.",
    dependencies: [
      {"kind":"construct","id":"firestore.semantic.hierarchical-match-cascade","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.rule-kind.match","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"OR composition across multiple allow-bearing match blocks that match the same path","verdict":"unsupported","reason":"the language snapshot enumerates the hierarchical-match cascade (parent/child nesting) but has no construct for multi-block OR composition, and no rules-engine registry row adjudicates it against the production Rules Test API"},
    ],
  },
  {
    id: "firestore.query-equality",
    service: "firestore",
    status: "unsupported",
    description: "Collection queries whose rules proof uses the supported equality subset.",
    dependencies: [
      {"kind":"construct","id":"firestore.rule-kind.allow-list","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.binding.request.query","verdict":"unsupported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":["firestore-rules#166"]},
      {"kind":"construct","id":"firestore.binding.resource.data","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.eq","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"firestore.operator.and","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"registry-row","id":"firestore-rules#166","verdict":"unsupported","surface":"firestore-rules","status":"diverged-documented","rulesEngineSurface":true},
    ],
  },
  {
    id: "rtdb.atomic-multipath",
    service: "rtdb",
    status: "unsupported",
    description: "Multi-child updates evaluated against one atomic projected tree.",
    dependencies: [
      {"kind":"construct","id":"rtdb.rule-kind.write","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.rule-kind.validate","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.newData","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"one projected future tree shared by every rule a multi-path update touches","verdict":"unsupported","reason":"atomicity across a multi-child update is not a language construct and no registry row adjudicates whole-update (as opposed to per-leaf) evaluation against production"},
    ],
  },
  {
    id: "rtdb.query",
    service: "rtdb",
    status: "unsupported",
    description: "Local ordering, bounds, equality, and limits; index enforcement is not modeled.",
    dependencies: [
      {"kind":"construct","id":"rtdb.rule-kind.read","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.rule-kind.indexOn","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.read-cascade","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"query constraints (orderBy/startAt/endAt/equalTo/limit) visible to a `.read` expression, and index enforcement rejecting an unindexed query","verdict":"unsupported","reason":"the RTDB language snapshot enumerates no query bindings, so the constraints a production `.read` rule can authorize against are not modeled by any construct, and no registry row adjudicates query-shape authorization"},
    ],
  },
  {
    id: "rtdb.read-write",
    service: "rtdb",
    status: "qualified",
    description: "Rules-respecting get, set, single-child update, and remove operations.",
    dependencies: [
      {"kind":"construct","id":"rtdb.rule-kind.read","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.rule-kind.write","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.rule-kind.location-wildcard","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.auth","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.auth.uid","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.auth.token","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.path-variable","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.method.snapshot.val","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.method.snapshot.child","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.method.snapshot.exists","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.operator.strictEq","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.operator.and","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.operator.or","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.operator.not","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.read-cascade","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.write-cascade","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.deny-by-default","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":false,"divergedBy":[]},
    ],
  },
  {
    id: "rtdb.rule-location-data",
    service: "rtdb",
    status: "unsupported",
    description: "Ancestor data/newData bindings and merged future-tree semantics.",
    dependencies: [
      {"kind":"construct","id":"rtdb.binding.data","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.newData","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.binding.root","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.write-cascade","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.semantic.validate-non-cascade","verdict":"qualified","snapshot":"unprobed","probe":"unprobeable","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"`data`/`newData` bound to an ANCESTOR rule location, with `newData` as the merged future tree of the whole write","verdict":"unsupported","reason":"the snapshot enumerates the data/newData bindings but not their rule-location binding or future-tree projection, and no registry row adjudicates ancestor-location binding against production"},
    ],
  },
  {
    id: "rtdb.transaction-listener",
    service: "rtdb",
    status: "unsupported",
    description: "Transaction retries, push-key allocation, and listener re-evaluation are not probe operations in v1.",
    dependencies: [
      {"kind":"construct","id":"rtdb.rule-kind.read","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"rtdb.rule-kind.write","verdict":"qualified","snapshot":"unprobed","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"rules re-evaluation on transaction retry, on push-key allocation, and on every listener event delivery","verdict":"unsupported","reason":"none of the three is a language construct, and no registry row adjudicates re-authorization on retry or on listener delivery against production"},
    ],
  },
  {
    id: "storage.advanced-rules",
    service: "storage",
    status: "supported",
    description: "Granular verbs, functions, time, regex, object identity, and Firestore rule lookups.",
    dependencies: [
      {"kind":"construct","id":"storage.rule-kind.allow-get","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-list","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-create","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-update","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-delete","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.function","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.let","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.method.string.matches","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.function.timestamp.date","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.function.timestamp.value","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.function.duration.value","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.function.firestore.get","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.function.firestore.exists","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.time","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.name","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.bucket","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.timeCreated","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.updated","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"registry-row","id":"storage-rules#116","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
    ],
  },
  {
    id: "storage.coarse-rules",
    service: "storage",
    status: "unsupported",
    description: "Coarse read/write with auth, size, content type, metadata, and path matching.",
    dependencies: [
      {"kind":"construct","id":"storage.rule-kind.match","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-read","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.rule-kind.allow-write","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.auth","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.auth.uid","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.auth.token","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.resource","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.resource.size","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.resource.contentType","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.request.resource.metadata","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource","verdict":"unsupported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":["storage-rules#118"]},
      {"kind":"construct","id":"storage.binding.resource.size","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.contentType","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.resource.metadata","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.binding.path-variable","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.eq","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.neq","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.lt","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.and","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.or","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.operator.not","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.semantic.read-umbrella","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.semantic.write-umbrella","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.semantic.recursive-wildcard","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"construct","id":"storage.semantic.deny-by-default","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"registry-row","id":"storage-rules#98","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#99","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#100","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#101","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#102","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#103","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
      {"kind":"registry-row","id":"storage-rules#114","verdict":"supported","surface":"storage-rules","status":"conforms","rulesEngineSurface":true},
    ],
  },
  {
    id: "storage.resumable-pagination",
    service: "storage",
    status: "unsupported",
    description: "Resumable transfer state and paginated list semantics are not probe operations in v1.",
    dependencies: [
      {"kind":"construct","id":"storage.rule-kind.allow-list","verdict":"supported","snapshot":"accepted","probe":"implemented","productionVerified":true,"divergedBy":[]},
      {"kind":"unbacked","id":"authorization of resumable-upload session state across chunks, and of a paginated list against its prefix","verdict":"unsupported","reason":"neither is a language construct, and no registry row adjudicates resumable-session or pagination authorization against production"},
    ],
  },
];

/** One dependency, as a sentence. The facts are the record; this is a view of
 *  them, built on read. */
export function describeCapabilityDependency(dependency: GeneratedCapabilityDependency): string {
  if (dependency.kind === "construct") {
    const facts = [
      `snapshot status "${dependency.snapshot}"`,
      `capability probe "${dependency.probe}"`,
      dependency.productionVerified
        ? "production-verified against captured production behavior"
        : "no production-captured scenario and no conforming oracle-backed row verifies it",
    ];
    if (dependency.divergedBy.length > 0) {
      facts.push(`covered by rules-engine divergence ${dependency.divergedBy.join(", ")}`);
    }
    return `${dependency.id}: ${facts.join("; ")}`;
  }
  if (dependency.kind === "registry-row") {
    const facts = [`registry row ${dependency.id} (${dependency.surface}) status "${dependency.status}"`];
    if (dependency.status === "diverged-documented") {
      facts.push(
        dependency.rulesEngineSurface
          ? "divergence is in the rules engine itself: the verdict machinery is known wrong here"
          : "divergence is in an SDK surface: the verdict machinery is sound, the probe setup is not production-identical",
      );
    }
    return `${dependency.id}: ${facts.join("; ")}`;
  }
  return `${dependency.id}: the conformance graph does not model this behavior: ${dependency.reason}`;
}

/** The reasons a probe cites when it abstains: the dependencies whose verdict
 *  pinned the capability's status, each rendered as a sentence. */
export function capabilityReasons(capability: GeneratedAssuranceCapability): string[] {
  return capability.dependencies
    .filter((dependency) => dependency.verdict === capability.status)
    .map(describeCapabilityDependency);
}
