import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Handle dispatch by `TARGET_SYMBOL` brand — refs route to their owning target via a `refToTarget` WeakMap (mirror of firestore's pattern)",
  status: "conforms",
  evidence: "`unit:modular/database-instances-cdd.test.ts` proves references from independent sandbox targets route to independent backends.",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/database/modular/database-instances-cdd.test.ts"],
  aliases: ["rtdb#99"],
});
