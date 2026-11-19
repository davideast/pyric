import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["getApp"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "getApp(name)",
  behavior: "`getApp(name)` for a name that was never initialized throws `FirebaseError` code `app/no-app`, directing the caller to `initializeApp()`",
  status: "conforms",
  evidence: "oracle: `app-registry-getapp-unknown-name` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code","specific-value"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code `app/no-app`","asserts the exact error message"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-getapp-unknown-name"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
