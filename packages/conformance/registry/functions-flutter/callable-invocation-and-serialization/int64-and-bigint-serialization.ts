import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'encodeCallableData() / decodeCallableData() (64-bit int, BigInt, Int64Value & UInt64Value)',
  behavior: 'Wraps 64-bit Dart int values outside IEEE-754 53-bit safe integer bounds and BigInt values as google.protobuf.Int64Value and decodes Int64Value and UInt64Value with full precision.',
  featureKeys: ['encodeCallableData', 'decodeCallableData', 'int64TypeUrl', 'uint64TypeUrl'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_serializer_and_url_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#1 regionalInt64Echo).',
  tests: [
    'packages/flutter-client/test/functions/functions_serializer_and_url_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
