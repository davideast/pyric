import { row } from './section.ts';

export default row({
  order: 50,
  status: "conforms",
  automation: "oracle-backed",
  behavior: "Re-signing in after `signOut` returns the **same** uid (passwords persist within the sandbox lifetime)",
  evidence: "oracle: `auth-handle-caching-live-currentuser-and-resignin.json`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["auth-handle-caching-live-currentuser-and-resignin"],
  conformanceTests: ["packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
