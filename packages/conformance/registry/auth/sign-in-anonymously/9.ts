import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "After `signOut`, a subsequent `signInAnonymously` mints a fresh uid",
  status: "conforms",
  evidence: "`unit:sandbox-anonymous.test.ts`, `playground:auth-anonymous` (bundled) + `playground:auth-row-9-anon-fresh-uid-after-signout` (one-claim)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
