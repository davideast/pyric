import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["deleteApp"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "deleteApp(app)",
  behavior: "`deleteApp` on an already-deleted app throws `FirebaseError` code `app/app-deleted`",
  status: "conforms",
  evidence: "oracle: `app-registry-deleteapp-double` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code","specific-value"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code `app/app-deleted`","asserts the exact error message"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-deleteapp-double"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
