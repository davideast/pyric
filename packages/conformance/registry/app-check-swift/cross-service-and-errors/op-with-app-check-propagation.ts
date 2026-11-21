import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

const AI_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-swift-ai-conformance.test.ts';
const FUNCTIONS_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-swift-functions-conformance.test.ts';
const STORAGE_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-swift-storage-conformance.test.ts';

export default row({
  order: 10,
  api: 'PyricBridgeClient.opWithAppCheck(app:method:params:) & shared FirebaseApp propagation',
  behavior: 'Attaches the active App Check JWT onto gated bridge, HTTP byte-route, and callable operations across FirebaseAI, Cloud Functions, and Cloud Storage while interoperating with Auth, Firestore, and Realtime Database on a shared FirebaseApp.',
  featureKeys: ['opWithAppCheck'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (bridgeWireOperationsAndErrorMapping), `packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift`, `packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift`, `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift`, and `packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckLiveHostTests.swift',
    'packages/swift-client/Tests/PyricAITests/PyricAILiveHostTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    'packages/swift-client/Tests/PyricStorageTests/StorageEdgeCaseLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
    STORAGE_LIVE_HOST_TEST,
  ],
  hostConformanceTests: [
    LIVE_HOST_CONFORMANCE_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
    STORAGE_LIVE_HOST_TEST,
  ],
});
