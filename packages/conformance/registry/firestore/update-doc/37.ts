import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Sandbox-live: each call re-evaluates auth (alice → bob between writes uses bob's auth)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"updateDoc re-evaluates auth per call\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
