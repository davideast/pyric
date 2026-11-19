import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Batch is tagged on construction and remains bound to the sandbox owner that created it",
  evidence: "`unit:firestore/sandbox-live-identity.test.ts` constructs a batch from sandbox A with a reference from sandbox B and proves the commit remains isolated to A.",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox ownership invariant — production has no cross-Sandbox owner seam",
});
