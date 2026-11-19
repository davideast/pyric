import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Sandbox-live: re-evaluates filters under the current user (different docs visible per identity)",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"query results re-evaluate under the current user\")",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
