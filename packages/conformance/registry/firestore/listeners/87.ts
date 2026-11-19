import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "Sandbox-live: listener registered as alice keeps emitting alice's view after `setUser → bob` (identity frozen at subscribe)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"listener registered as alice keeps emitting alice's view\")",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
