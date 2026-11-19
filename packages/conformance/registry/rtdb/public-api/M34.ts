import { row } from './section.ts';

export default row({
  order: 430,
  featureKeys: ["setData"],
  behavior: "`sandbox.setData(db, { '/path': value })` bulk-loads data, bypassing rules",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"sandbox.setData seeds the tree (rule-bypass)\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 34,
});
