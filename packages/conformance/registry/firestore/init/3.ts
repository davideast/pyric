import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Package resolution owns production selection: direct `pyric/firestore` rejects a real `FirebaseApp`, while inactive canonical `firebase/firestore` imports remain the real Firebase SDK",
  evidence: "`unit:package-resolution.test.ts`, `node-register:register-child.test.ts` (inactive canonical imports are not rewritten)",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/package-resolution.test.ts","packages/cli/test/register/register-child.test.ts"],
});
