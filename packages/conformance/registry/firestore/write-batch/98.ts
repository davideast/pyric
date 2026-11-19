import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Batch identity is frozen at construction (per current implementation)",
  evidence: "`unit:firestore/sandbox-live-identity.test.ts` constructs under alice, switches the live session to bob, and proves commit still succeeds under alice's captured identity.",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox live-session invariant — production has no mutable Sandbox.currentUser seam to probe",
});
