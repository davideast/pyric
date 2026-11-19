import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Two `getDatabase(sandbox)` calls share state (same underlying `LocalEnvironment`)",
  status: "conforms",
  evidence: "`unit:modular/database-instances-cdd.test.ts` writes through one handle and reads through another handle owned by the same sandbox.",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/database-instances-cdd.test.ts"],
  aliases: ["rtdb#98"],
});
