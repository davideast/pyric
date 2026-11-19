import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Two `getFirestore(sandbox)` calls share state (same underlying `LocalEnvironment`)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"two handles share the same sandbox\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
