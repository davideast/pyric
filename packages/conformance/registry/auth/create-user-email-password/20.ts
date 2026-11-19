import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Creates a new user, signs them in automatically (currentUser becomes the new user)",
  evidence: "`playground:auth-email-password` (bundled) + `playground:auth-row-20-create-user-auto-signs-in` (one-claim), `unit:sandbox-email-password.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-email-password.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
