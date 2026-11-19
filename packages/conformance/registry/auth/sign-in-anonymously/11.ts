import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Writes through to `sandbox.currentUser` so rules engines see `request.auth.uid`",
  status: "conforms",
  evidence: "`unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-11-anon-uid-visible-to-rules` (one-claim)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
