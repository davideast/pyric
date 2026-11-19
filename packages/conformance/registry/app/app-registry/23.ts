import { row } from './section.ts';

export default row({
  order: 230,
  featureKeys: ["initializeApp"],
  section: "Shared backend invariant",
  api: "initializeApp(equalOptions, name)",
  behavior: "Equal-config app instances connect to one logical backend: data written through one app is readable through another, while their active Auth sessions remain independent",
  status: "conforms",
  evidence: "oracle: `app-production-multi-app-topology` (firebase 12.19.0, real Chromium against production) + twin replay: `production-multi-app-oracle.test.ts`; served SharedWorker replay: `app-multi-app.pw.ts`",
  risk: ["stateful","structural"],
  riskScore: 3,
  riskReasons: ["asserts shared persistent state across app containers"],
  automation: "oracle-backed",
  oracleObservations: ["app-production-multi-app-topology"],
  conformanceTests: ["packages/pyric/test/app/production-multi-app-oracle.test.ts","packages/cli/test/e2e/app-multi-app.pw.ts"],
});
