import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

interface RowSeed {
  ref: number;
  api: string;
  behavior: string;
  featureKeys: string[];
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

const buildRow = defineRows({
  surface: 'functions-rtdb',
  defaults: { section: '`firebase-functions/v2/database.onValueCreated`' },
});

function row(seed: RowSeed): CompatibilityRow {
  const { ref, observations = [], flipped, ...rest } = seed;
  const observed = observations.length > 0;
  // A flipped row's assertion set passes in the blocking test path; the
  // builder's zero-risk defaults describe exactly that state.
  const climb = flipped
    ? {
        status: 'conforms' as const,
        automation: flipped,
        evidence: `${seed.evidence} Local replay: \`${CONFORMANCE_SUITE}\` assertion set \`functions-rtdb#${ref}\`.`,
        conformanceTests: [CONFORMANCE_SUITE],
      }
    : {
        status: 'unverified' as const,
        automation: 'unverified' as const,
        risk: [observed ? 'cited-not-replayed' : 'unobserved'],
        riskScore: observed ? 1 : 2,
        riskReasons: [observed ? CITED_NOT_REPLAYED_REASON : UNOBSERVED_REASON],
      };
  return buildRow({ ...rest, rowRef: String(ref), oracleObservations: observations, ...climb });
}

export const functionsRtdbRows: CompatibilityRow[] = [
  row({
    ref: 1,
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["DatabaseEvent"],
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
    featureKeys: ["DatabaseEvent"],
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
    featureKeys: ["DatabaseEvent"],
    flipped: 'oracle-backed',
    api: 'DatabaseEvent.authType / authId',
    behavior:
      'For the production Admin SDK write, the event exposes authType `unknown` and authId `null`.',
    evidence: 'oracle: `functions-rtdb-onvaluecreated-exact-create.json`.',
    observations: ['functions-rtdb-onvaluecreated-exact-create'],
  }),
  row({
    ref: 11,
    featureKeys: ["onValueCreated"],
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
    featureKeys: ["onValueCreated"],
    api: 'onValueCreated(ref, handler)',
    behavior:
      'A handler that throws or returns a rejected Promise is reported by the managed runtime; with retry disabled, the Eventarc request can still be acknowledged with HTTP 200.',
    evidence:
      'oracle: `functions-rtdb-onvaluecreated-failed-execution.json`; Pyric observes the rejected handler and marker, but has no Eventarc HTTP request seam with which to replay the captured 200 acknowledgement.',
    observations: ['functions-rtdb-onvaluecreated-failed-execution'],
  }),
  row({
    ref: 13,
    featureKeys: ["onValueCreated"],
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

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — unchanged source matches production under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match production but does not |
| — | **Not implemented yet** — explicitly outside the implemented slice |
| ? | **Unverified** — production target or local replay is incomplete |
`;

export const functionsRtdbRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-rtdb',
  label: 'Functions · RTDB',
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
