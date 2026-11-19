import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["refEqual"],
  behavior: "`refEqual` is `true` for cross-flavor sandbox vs sandbox-live refs at the same path",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"refEqual returns true for live and frozen refs at the same path\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
