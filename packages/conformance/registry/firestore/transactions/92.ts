import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Identity is frozen at `runTransaction` start — mid-transaction `setUser` does NOT re-auth in-flight reads",
  status: "conforms",
  evidence: "`unit:firestore/sandbox-live-identity.test.ts` changes the live session from alice to bob inside the callback; the transaction still reads and commits under alice's captured identity.",
  risk: ["atomicity"],
  riskScore: 2,
  riskReasons: ["asserts transaction/batch atomicity"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox live-session invariant — production has no mutable Sandbox.currentUser seam to probe",
});
