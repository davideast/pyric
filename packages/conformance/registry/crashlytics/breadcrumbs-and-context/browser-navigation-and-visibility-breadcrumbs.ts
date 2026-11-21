import { row } from './section.ts';

export default row({
  order: 20,
  api: "Automatic popstate, hashchange, and visibilitychange breadcrumbs",
  behavior: "Records navigation:<pathname> and visibility:<state> breadcrumbs when breadcrumbs() is enabled in CrashlyticsOptions.features and detaches DOM listeners on deleteApp().",
  featureKeys: ["CrashlyticsOptions.features"],
  statusNote: "Verified in in-process unit suite with synthetic window/document targets; not yet exercised against a live browser page.",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` (`captures browser unhandled errors and navigation/visibility breadcrumbs, detaching on deleteApp`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
  ],
});
