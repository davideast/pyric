import { row } from './section.ts';

export default row({
  order: 50,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "`auth.currentUser` is a live getter, not a snapshot - reads through to the backend on every access",
  evidence: "`unit:sandbox-anonymous.test.ts`, oracle: `auth-handle-caching-live-currentuser-and-resignin.json`",
  oracleObservations: ["auth-handle-caching-live-currentuser-and-resignin"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-anonymous.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
