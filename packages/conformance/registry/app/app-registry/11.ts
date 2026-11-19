import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["SDK_VERSION"],
  section: "`FirebaseError` / `SDK_VERSION` / logger seam",
  api: "SDK_VERSION",
  behavior: "`SDK_VERSION` is the Firebase client SDK semver string whose behavior pyric currently mirrors, pinned to the oracle version (`12.19.0`)",
  status: "conforms",
  evidence: "oracle: `app-registry-sdk-version` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts the exact SDK version string"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-sdk-version"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
