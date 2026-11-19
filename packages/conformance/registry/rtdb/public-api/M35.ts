import { row } from './section.ts';

export default row({
  order: 440,
  featureKeys: ["snapshotState"],
  behavior: "`sandbox.snapshotState(db)` dumps the full tree as a plain JSON object",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"sandbox.snapshotState dumps the full tree\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 35,
});
