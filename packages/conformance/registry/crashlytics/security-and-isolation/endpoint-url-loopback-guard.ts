import { row } from './section.ts';

export default row({
  order: 30,
  api: "CrashlyticsOptions.endpointUrl loopback and local-path enforcement",
  behavior: "Accepts loopback (127.0.0.1, localhost, [::1]) and relative local paths in CrashlyticsOptions.endpointUrl while synchronously refusing external or empty URLs with FirebaseError('crashlytics/invalid-endpoint').",
  featureKeys: ["validateCrashlyticsEndpointUrl"],
  statusNote: "Verified in in-process unit suite; served pages swap transport before HTTP OTLP export.",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` (`validates endpointUrl strictly against loopback or local paths and refuses external hosts`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
  ],
});
