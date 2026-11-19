import { row } from './section.ts';

export default row({
  order: 420,
  featureKeys: ["setRules"],
  behavior: "`sandbox.setRules(db, rulesJson)` deploys rules to the in-process simulator; `setRules(db, null)` clears rules (default-allow)",
  status: "conforms",
  evidence: "`unit:modular/sandbox-target.test.ts` (\"sandbox.setRules(db, null) clears rules\"). Each rule expression of the deployed ruleset is parsed once, on its first evaluation, and later writes, multi-path updates, reads, and `simulate()` calls on a compiled ruleset reuse that parse; the next `setRules` call parses the new ruleset (`unit:database/sandbox/rules-parse-count.test.ts`).",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts","packages/pyric/test/database/sandbox/rules-parse-count.test.ts"],
  rowNumber: 33,
});
