import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`request.auth.uid` reads through to `sandbox.currentUser?.uid` on sandbox-live",
  status: "conforms",
  evidence: "`playground:auth-anonymous`, `playground:rules-cross-doc-get`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "sandbox-only",
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
