import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`getDatabase(ctx)` returns a tagged sandbox-target handle (frozen identity)",
  status: "conforms",
  evidence: "`unit:modular/database-instances-cdd.test.ts` asserts the returned Database carries a sandbox target.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/database-instances-cdd.test.ts"],
  aliases: ["rtdb#94"],
});
