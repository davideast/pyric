import { row } from './section.ts';

export default row({
  order: 10,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Returns a stable `Auth` handle for repeated calls with the same input",
  evidence: "`unit:sandbox-anonymous.test.ts` + `register-child.test.ts`, oracle: `auth-handle-caching-live-currentuser-and-resignin.json`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  oracleObservations: ["auth-handle-caching-live-currentuser-and-resignin"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts","packages/cli/test/register/register-child.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
