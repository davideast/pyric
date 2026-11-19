import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`getFirestore(sandbox)` returns a tagged sandbox-live handle (per-op identity)",
  evidence: "`unit:sandbox-live-identity.test.ts`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
