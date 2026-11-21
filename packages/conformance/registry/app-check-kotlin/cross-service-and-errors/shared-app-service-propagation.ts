import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

const STORAGE_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-kotlin-storage-conformance.test.ts';
const AI_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-kotlin-ai-conformance.test.ts';
const FUNCTIONS_LIVE_HOST_TEST =
  'packages/cli/test/serve/native-kotlin-functions-conformance.test.ts';

export default row({
  order: 10,
  api: 'FirebaseApp shared appCheckTokenProvider (Auth, Firestore, RTDB, Storage, AI, Functions)',
  behavior: 'Automatically mints or reuses the active App Check JWT and attaches it to Auth, Firestore, Realtime Database, Cloud Storage HTTP byte-routes, Cloud Functions callables, and Firebase AI requests bound to the same FirebaseApp.',
  featureKeys: ['attachesMintedAppCheckTokenAutomaticallyAcrossSharedFirebaseAppServices', 'x-firebase-appcheck'],
  status: 'conforms',
  evidence: 'Verified in `packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt`, `packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt`, and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/appcheck/FirebaseAppCheckTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/storage/StoragePathBinaryAndAppCheckParityTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AppCheckLiveBridgeTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/StorageEdgeCaseLiveHostConformanceTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AiLiveHostConformanceTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
    STORAGE_LIVE_HOST_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
  ],
  hostConformanceTests: [
    LIVE_HOST_CONFORMANCE_TEST,
    STORAGE_LIVE_HOST_TEST,
    AI_LIVE_HOST_TEST,
    FUNCTIONS_LIVE_HOST_TEST,
  ],
});
