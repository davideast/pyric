import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Returns the pre-staged `UserCredential` registered via `sandbox.mockSignInResult(auth, …)`",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
