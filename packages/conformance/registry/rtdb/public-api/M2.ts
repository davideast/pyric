import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getDatabase"],
  behavior: "`getDatabase(sandbox)` builds a sandbox-live target; reads `sandbox.currentUser` per op",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"reads sandbox.currentUser at op time, not at getDatabase time\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
  rowNumber: 2,
});
