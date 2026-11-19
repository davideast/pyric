import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["browserLocalPersistence"],
  api: "browserLocalPersistence across same-named app instances in sibling tabs",
  behavior: "After the sibling receives the LOCAL persistence event, same-named Firebase app instances in sibling tabs keep independent active Auth sessions; an anonymous sign-in in one tab does not update the sibling tab's currentUser during the bounded post-signal observation window",
  evidence: "oracle: `app-production-cross-tab-auth-persistence` (firebase 12.19.0, two real Chromium pages in one browser context) + served twin: `packages/cli/test/e2e/app-multi-app.pw.ts`",
  riskReasons: ["asserts cross-tab session isolation for the same app name","asserts listener non-delivery across sibling tabs"],
  oracleObservations: ["app-production-cross-tab-auth-persistence"],
  conformanceTests: ["packages/cli/test/e2e/app-multi-app.pw.ts"],
});
