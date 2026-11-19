import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["doc"],
  behavior: "Held doc/coll ref under `sandbox-live` re-resolves to the chainable under the current user at op time (via rebuild closure)",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"held doc ref re-resolves under the current user\")",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
