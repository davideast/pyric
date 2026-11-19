import { row } from './section.ts';

export default row({
  order: 160,
  featureKeys: ["initializeApp"],
  section: "`FirebaseApp` container shape",
  api: "initializeApp(options, settings)",
  behavior: "`initializeApp` snapshots options, accepts a settings object, initializes `automaticDataCollectionEnabled`, and leaves that app property mutable",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-settings-options` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural","specific-value"],
  riskScore: 2,
  riskReasons: ["asserts the default/mutable app setting values"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-settings-options"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
