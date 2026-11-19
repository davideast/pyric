import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`sandbox.setUser` (the sandbox-only test driver) BYPASSES the gate entirely — it is a raw identity force with no prod analog (same bypass it already has for provider enforcement / `signInProvider` tracking), so no registered `beforeAuthStateChanged` callback runs and none can block it.",
  status: "diverged-documented",
  evidence: "`unit:sandbox-before-auth-state-changed.test.ts` (\"sandbox.setUser test driver bypasses the gate\")",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-before-auth-state-changed.test.ts"],
  notes: "Deliberate: `sandbox.setUser` exists ONLY to drive auth state directly in tests without a real sign-in flow, so there is nothing for a sign-in gate to meaningfully block. Documented, not a bug.",
  rowNumber: 76,
});
