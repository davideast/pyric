import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FunctionsSerializer (Int64Value / UInt64Value 64-bit integer & Foundation codecs)',
  behavior: 'Wraps 64-bit signed and unsigned integers as google.protobuf.Int64Value / UInt64Value JSON envelopes and preserves Bool vs NSNumber, NSNull, Array, and Dictionary types.',
  featureKeys: ['Int64Value', 'UInt64Value', 'FunctionsSerializer'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (serializerRoundTripAndValidation) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (regionalInt64Echo).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
