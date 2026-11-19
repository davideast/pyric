import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["Timestamp"],
  automation: "oracle-backed",
  behavior: "`Timestamp` shape (`{seconds, nanoseconds}`) is identical between prod and sandbox — round-trips cleanly",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-timestamp-roundtrip-and-negative-millis`",
  oracleObservations: ["firestore-timestamp-roundtrip-and-negative-millis"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-sentinels-scalars.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-sentinels-scalars.test.ts"],
});
