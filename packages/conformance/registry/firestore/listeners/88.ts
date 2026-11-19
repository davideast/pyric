import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "Sandbox-live: listener registered as anonymous keeps firing after sign-in (anonymous → signed-in identity persists per listener)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"listener registered as anonymous on /public keeps firing after sign-in\")",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
