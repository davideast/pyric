import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "The created user has `isAnonymous: false`, `email: <input>`, `displayName: null`",
  evidence: "`unit:sandbox-email-password.test.ts` + `playground:auth-row-23-create-user-shape` (one-claim)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
