import { row } from './section.ts';

export default row({
  order: 20,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Returns `Promise<void>`",
  evidence: "`unit:types.test.ts`, oracle: `auth-setpersistence-and-firebaseerror-wrapper.json`",
  oracleObservations: ["auth-setpersistence-and-firebaseerror-wrapper"],
  conformanceTests: ["packages/pyric/test/auth/types.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
