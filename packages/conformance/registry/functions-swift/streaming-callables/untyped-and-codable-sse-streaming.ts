import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'HTTPSCallable.stream(_:) / Callable.stream(_:) / StreamResponse<Message, Result>',
  behavior: 'Streams callable responses over Accept: text/event-stream as AsyncThrowingStream, reassembling split UTF-8 frames, decoding untyped or Codable .message and .result events, and cancelling the SSE request on task termination.',
  featureKeys: ['HTTPSCallable.stream', 'StreamResponse', 'HTTPSCallableStreamResponse'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (streamingSSEParsingTypedDecodingAndCancellation) and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
