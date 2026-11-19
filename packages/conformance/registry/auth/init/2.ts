import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`getAuth(sandbox)` dispatches to the sandbox backend",
  status: "conforms",
  evidence: "`unit:sandbox-anonymous.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts"],
});
