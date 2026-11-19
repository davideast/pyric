import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getDatabase"],
  behavior: "`getDatabase(ctx)` builds a sandbox-target `Database`; frozen `ctx.auth` baked in",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"getDatabase(ctx) returns a tagged Database handle\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 1,
});
