import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`getFirestore(ctx)` returns a tagged sandbox-target handle (frozen identity)",
  evidence: "`unit:sandbox-target.test.ts`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
