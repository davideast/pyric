import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "No-op on sandbox-target handles (the sandbox already IS a local emulator)",
  evidence: "`unit:sandbox-target.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
