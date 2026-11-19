import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["deleteApp"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "deleteApp(app)",
  behavior: "`deleteApp(app)` returns a Promise, deregisters the app (so `getApps()` shrinks), a later `getApp(name)` throws `app/no-app`, and the name can be re-initialized afterwards",
  status: "conforms",
  evidence: "oracle: `app-registry-deleteapp` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code"],
  riskScore: 3,
  riskReasons: ["asserts Firebase error code `app/no-app` after deletion"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-deleteapp"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
