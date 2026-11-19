import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Handle dispatch by `TARGET_SYMBOL` brand — refs/queries route to their owning target via `refToTarget` WeakMap",
  evidence: "`unit:sandbox-target.test.ts` (\"throws TypeError for refs not produced by this package\")",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
