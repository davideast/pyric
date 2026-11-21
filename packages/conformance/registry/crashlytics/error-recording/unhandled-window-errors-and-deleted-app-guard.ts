import { row } from './section.ts';

export default row({
  order: 20,
  api: "captureUnhandledErrors (window error & unhandledrejection) / app/app-deleted guard",
  behavior: "Captures unhandled window error and unhandledrejection events as fatal: true reports when captureUnhandledErrors !== false, detaches listeners on deleteApp(), and rejects post-delete calls with FirebaseError('app/app-deleted').",
  featureKeys: ["CrashlyticsOptions.captureUnhandledErrors"],
  statusNote: "Verified in in-process unit suite with synthetic window error/unhandledrejection events; not yet exercised against a live browser page.",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` (`captures browser unhandled errors and navigation/visibility breadcrumbs, detaching on deleteApp`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
  ],
});
