import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Sandbox-live: returned ref is a *live* ref (rebuild closure recorded) so follow-ups re-resolve auth",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"addDoc result is a tagged live ref\")",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
