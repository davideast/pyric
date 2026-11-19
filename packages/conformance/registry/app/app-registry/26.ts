import { row } from './section.ts';

export default row({
  order: 260,
  featureKeys: ["deleteApp"],
  section: "`FirebaseApp` deletion lifecycle",
  api: "deleteApp(app)",
  behavior: "Deleting one app terminates its Firestore listener through the error callback with code `aborted`, silently stops its RTDB listener, and leaves equal-config sibling listeners and the shared backend usable",
  status: "conforms",
  evidence: "oracle: `app-production-multi-app-topology` (firebase 12.19.0, real Chromium against production) + twin replay: `production-multi-app-oracle.test.ts`; focused family tests: `multi-app-listener-auth.test.ts` and served `app-multi-app.pw.ts`",
  risk: ["listener","stateful","structural"],
  riskScore: 5,
  riskReasons: ["asserts service-specific listener termination and sibling isolation"],
  automation: "oracle-backed",
  oracleObservations: ["app-production-multi-app-topology"],
  conformanceTests: ["packages/pyric/test/app/production-multi-app-oracle.test.ts","packages/pyric/test/app/multi-app-listener-auth.test.ts","packages/cli/test/e2e/app-multi-app.pw.ts"],
});
