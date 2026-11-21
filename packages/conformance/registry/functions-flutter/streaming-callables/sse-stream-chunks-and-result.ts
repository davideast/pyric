import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'HttpsCallable.stream<T, R>([parameters]) / StreamResponse / Chunk<T, R> / Result<T, R>',
  behavior: 'Streams callable responses over Accept: text/event-stream, reassembling split UTF-8 SSE lines, emitting sealed Chunk<T, R> and terminal Result<T, R> events, and cancelling SSE subscriptions on stream cancel.',
  featureKeys: ['HttpsCallable.stream', 'StreamResponse', 'Chunk'],
  status: 'conforms',
  evidence: 'Verified in `packages/flutter-client/test/functions/functions_callable_unit_test.dart` and `packages/flutter-client/test/live_host/functions_live_host_test.dart` (functions-live#4).',
  tests: [
    'packages/flutter-client/test/functions/functions_callable_unit_test.dart',
    'packages/flutter-client/test/live_host/functions_live_host_test.dart',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
