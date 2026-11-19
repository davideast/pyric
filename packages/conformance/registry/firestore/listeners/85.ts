import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`SnapshotListenOptions.includeMetadataChanges` — one write yields the pending-write local echo (`hasPendingWrites: true`) then, for metadata listeners, the settled ack fire: default listener 2 fires, metadata listener 3",
  evidence: "Aligned via the listener delivery scheduler (`src/sandbox/firestore/local-environment.ts` + `snapshot-listeners.ts`): the write echo carries `hasPendingWrites: true` and `includeMetadataChanges` listeners receive the settled metadata-only ack, reproducing prod's recorded 2/3-fire sequences exactly. Machine-checked against `packages/conformance/observations/firestore/firestore-include-metadata-changes.json` in `oracle-conformance.test.ts` (fire counts and per-fire `hasPendingWrites` sequence asserted from the capture). The served worker forwards `includeMetadataChanges` with the subscription and `hasPendingWrites` with each snapshot frame, so a served listener receives the same 2/3-fire sequence and metadata: `unit:query-snapshot-doc-changes.test.ts`. Known divergence in served mode: one sandbox serves every tab, Studio and every native client, and the sandbox marks every write echo pending whichever session wrote it, so a served listener reports `hasPendingWrites: true` for a write made by another tab, by Studio or by a native client, where production reports `false` for writes from other clients",
  risk: ["listener-fire-count","specific-field","listener","metadata"],
  riskScore: 6,
  riskReasons: ["asserts a specific listener fire count","asserts a specific field/property value","asserts listener semantics","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-include-metadata-changes"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/characterization/metadata-ack.test.ts","packages/cli/test/serve/worker/query-snapshot-doc-changes.test.ts"],
});
