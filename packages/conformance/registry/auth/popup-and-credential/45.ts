import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `auth/no-mock-configured` when no mock is pre-staged",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts`",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/no-mock-configured`"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
