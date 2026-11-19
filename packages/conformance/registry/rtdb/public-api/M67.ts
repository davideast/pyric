import { row } from './section.ts';

export default row({
  order: 760,
  featureKeys: ["ref","set","remove"],
  behavior: "`null` children and empty objects are pruned at the write boundary — `set(ref, {})` is equivalent to `remove(ref)`; nested `null` collapses empty ancestors (\"empty nodes don't exist\") (DB-B3)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/normalization.test.ts` (\"set(ref, {}) is equivalent to remove\" + \"null children are pruned\"); matches oracle `rtdb-modular-null-and-empty-ancestor-pruning.json` (local + SharedWorker + Node host replay); upstream `core/snap/nodeFromJSON.ts:78-88,122-126`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-null-and-empty-ancestor-pruning"],
  conformanceTests: ["packages/pyric/test/database/modular/normalization.test.ts","packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts"],
  rowNumber: 67,
});
