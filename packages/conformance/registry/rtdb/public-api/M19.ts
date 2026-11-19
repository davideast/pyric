import { row } from './section.ts';

export default row({
  order: 200,
  featureKeys: ["push","pushKey"],
  behavior: "`pushKey()` mints a fresh push-shaped key without writing -- used by callers building multi-path updates that need the key first",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"pushKey() mints a fresh key without writing\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 19,
});
