import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`request.auth == null` when sandbox.currentUser is null (anonymous path)",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"anonymous fallback\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
