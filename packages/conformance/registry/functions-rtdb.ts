import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

interface RowSeed {
  ref: number;
  api: string;
  behavior: string;
  evidence: string;
  observations?: string[];
  /** Set only when the unchanged local replay passes for this row. */
  flipped?: 'oracle-backed';
}

const CONFORMANCE_SUITE =
  'packages/cli/test/functions-rtdb/oracle-conformance.test.ts';

const UNOBSERVED_REASON =
  'Behavior stated from the firebase-functions 7.2.5 public contract; production capture has not landed yet.';
const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but Pyric has no local Functions runtime to replay it yet.';

function row(seed: RowSeed): CompatibilityRow {
  const observations = seed.observations ?? [];
  const observed = observations.length > 0;
  return {
    id: `functions-rtdb#${seed.ref}`,
    surface: 'functions-rtdb',
    aliases: [],
    rowRef: String(seed.ref),
    rowNumber: seed.ref,
    section: '`firebase-functions/v2/database.onValueCreated`',
    api: seed.api,
    behavior: seed.behavior,
    status: seed.flipped ? 'conforms' : 'unverified',
    evidence: seed.flipped
      ? `${seed.evidence} Local replay: \`${CONFORMANCE_SUITE}\` assertion set \`functions-rtdb#${seed.ref}\`.`
      : seed.evidence,
    risk: seed.flipped ? [] : [observed ? 'cited-not-replayed' : 'unobserved'],
    riskScore: seed.flipped ? 0 : observed ? 1 : 2,
    riskReasons: seed.flipped
      ? []
      : [observed ? CITED_NOT_REPLAYED_REASON : UNOBSERVED_REASON],
    automation: seed.flipped ?? 'unverified',
    oracleObservations: observations,
    conformanceTests: seed.flipped ? [CONFORMANCE_SUITE] : [],
  };
}

export const functionsRtdbRows: CompatibilityRow[] = [
  row({
    ref: 1,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'A write that changes an exact matched RTDB location from absent to present invokes the handler once with a create CloudEvent and a DataSnapshot containing the created value.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-exact-create.json` (firebase-functions 7.2.5); production exact-create behavior.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 2,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'After the initial create delivery, changing or deleting that same matched value does not invoke an onValueCreated handler.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; update/delete produced no additional delivery in the bounded production scenario.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 3,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'A value that already exists when the trigger is deployed does not produce a historical create delivery.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-startup-existing.json`; pre-seeded value, zero delivery in the observation window.',
    observations: ['functions-rtdb-onvaluecreated-startup-existing'],
  }),
  row({
    ref: 4,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'A named single-segment wildcard matches a created child and exposes the matched segment through event.params.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; production populated caseId and itemId.',
    observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
  }),
  row({
    ref: 5,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'Creating an ancestor object invokes the wildcard handler once for each newly-present matching descendant.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one ancestor set delivered alpha and beta.',
    observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
  }),
  row({
    ref: 6,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'When an ancestor write creates an exact matched descendant, the event snapshot is projected to that descendant rather than the ancestor object.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-descendant-projection.json`; leaf snapshot excluded its sibling.',
    observations: ['functions-rtdb-onvaluecreated-descendant-projection'],
  }),
  row({
    ref: 7,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'One multi-location update that creates multiple wildcard-matched children produces one create delivery for each child.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; one update delivered delta and gamma.',
    observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
  }),
  row({
    ref: 8,
    flipped: 'oracle-backed',
    api: 'DatabaseEvent.data',
    behavior:
      'The delivered DataSnapshot exposes the created value, key, existence, JSON projection, child lookup, child count, and child enumeration.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; frozen val/key/exists/toJSON/child enumeration shape.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 9,
    flipped: 'oracle-backed',
    api: 'DatabaseEvent.data.ref',
    behavior:
      'The snapshot ref is an Admin DatabaseReference rooted at the matched path and can perform an awaited write from the handler.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; matched Admin ref completed the awaited sibling write.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 10,
    flipped: 'oracle-backed',
    api: 'DatabaseEvent.authType / authId',
    behavior:
      'For the production Admin SDK write, the event exposes authType `unknown` and authId `null`.',
    evidence: 'oracle: `functions-rtdb-onvaluecreated-exact-create.json`.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 11,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, async handler)',
    behavior:
      'A Promise returned by the handler keeps the execution open through delayed asynchronous work and its awaited Admin write.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-exact-create.json`; capture logged only after the delayed Admin write completed.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 12,
    api: 'onValueCreated(ref, handler)',
    behavior:
      'A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-failed-execution.json`; Pyric observes the rejected handler and marker, but has no Eventarc HTTP request seam with which to replay the captured 200 acknowledgement.',
    observations: ['functions-rtdb-onvaluecreated-failed-execution'],
  }),
  row({
    ref: 13,
    flipped: 'oracle-backed',
    api: 'onValueCreated(ref, handler)',
    behavior:
      'Sequential creates are all delivered; their observed arrival order is evidence, not an ordering guarantee.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-wildcard-batches.json`; all three arrived in observed order 2, 1, 3.',
    observations: ['functions-rtdb-onvaluecreated-wildcard-batches'],
  }),
];

const INTRO = `# Firebase Functions RTDB integration compatibility

This matrix describes unchanged production source imported from
\`firebase-functions/v2/database\` and run against Pyric during development.
It is an integration/runtime contract, not a \`pyric-functions\` package mirror.

The first slice is intentionally narrow: Node, \`onValueCreated\`, one RTDB
instance, exact paths and named single-segment wildcards, serialized handler
execution within the current development session without a cross-event ordering
guarantee, and Admin-capable references on the event snapshot. Every row begins
unverified and remains a gap until its
production observation is replayed through the unchanged source against Pyric.

Explicitly deferred: other trigger types and Firebase products, retries,
deployed concurrency settings, multiple database instances, durable delivery
across restarts, deployment emulation, secrets, and production lifecycle
configuration.

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — unchanged source matches production under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match production but does not |
| — | **Unsupported** — explicitly outside the implemented slice |
| ? | **Unverified** — production target or local replay is incomplete |
`;

export const functionsRtdbRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-rtdb',
  compatPath: 'packages/cli/docs/functions-rtdb/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    {
      kind: 'table',
      prefix: '## `onValueCreated` delivery and event contract\n',
      rows: functionsRtdbRows,
    },
  ],
};
