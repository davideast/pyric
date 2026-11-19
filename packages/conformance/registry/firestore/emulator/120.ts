import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Production does not enter the mirror: inactive package resolution leaves Firebase's `connectFirestoreEmulator` implementation unchanged",
  evidence: "`node-register:register-child.test.ts` (inactive canonical Firestore is not rewritten)",
  automation: "unit-backed",
  conformanceTests: ["packages/cli/test/register/register-child.test.ts"],
});
