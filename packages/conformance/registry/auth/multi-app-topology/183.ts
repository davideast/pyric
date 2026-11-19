import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getAuth"],
  api: "getAuth(app)",
  behavior: "Equal-config Firebase apps have independent active Auth sessions; signing in or out on one app does not change another app's currentUser",
  evidence: "oracle: `app-production-multi-app-topology` (firebase 12.19.0, real Chromium against production) + twin replay: `packages/pyric/test/app/production-multi-app-oracle.test.ts`",
  riskReasons: ["asserts state isolation across app-associated Auth services","asserts listener isolation across app-associated Auth services"],
  oracleObservations: ["app-production-multi-app-topology"],
  conformanceTests: ["packages/pyric/test/app/production-multi-app-oracle.test.ts"],
});
