import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`getDatabase(sandbox)` returns a tagged sandbox-live handle (per-op identity)",
  status: "conforms",
  evidence: "`unit:modular/database-instances-cdd.test.ts` asserts the returned Database carries a sandbox-live target.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "sandbox-only",
  conformanceTests: ["packages/pyric/test/database/modular/database-instances-cdd.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
  aliases: ["rtdb#95"],
});
