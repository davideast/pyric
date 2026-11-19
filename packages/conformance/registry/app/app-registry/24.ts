import { row } from './section.ts';

export default row({
  order: 240,
  featureKeys: ["deleteApp"],
  section: "`FirebaseApp` deletion lifecycle",
  api: "deleteApp(app); app.name / app.options / app.automaticDataCollectionEnabled",
  behavior: "After deletion resolves, every public FirebaseApp property accessor throws `FirebaseError` code `app/app-deleted`",
  status: "conforms",
  evidence: "oracle: `app-registry-deleted-property-access` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code","structural"],
  riskScore: 3,
  riskReasons: ["asserts Firebase error code `app/app-deleted` for each public app accessor"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-deleted-property-access"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
