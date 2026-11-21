import { row } from './section.ts';

export default row({
  order: 30,
  api: "64-entry rolling breadcrumb cap, NaN/Infinity normalization & ArgumentError key validation",
  behavior: "Caps rolling breadcrumbs at 64 FIFO entries, normalizes NaN and Infinity doubles to string literals, and throws ArgumentError on blank custom keys or non-scalar values.",
  featureKeys: ["CrashlyticsWireCodec"],
  evidence: "Verified in `packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart` (`normalizes non-finite doubles and rejects empty keys or invalid types` and `caps rolling breadcrumbs at 64 FIFO entries`).",
  tests: [
    "packages/flutter-client/test/crashlytics/firebase_crashlytics_unit_test.dart",
  ],
});
