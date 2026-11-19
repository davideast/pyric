import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "After successful sign-in, `currentUser` becomes the mock's `user`, listeners fire",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
