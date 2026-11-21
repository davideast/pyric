import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'FirebaseFunctions.getHttpsCallableFromUrl(url, options?) & local gateway routing',
  behavior: 'Rewrites project cloudfunctions.net URLs and loopback custom domains onto the local Pyric Functions HTTP gateway while refusing foreign projects and off-machine origins with Code.UNAVAILABLE before network I/O.',
  featureKeys: ['getHttpsCallableFromUrl'],
  status: 'diverged-documented',
  statusNote: 'local gateway & off-machine guard',
  evidence: 'Instead of sending HTTPS requests to external Cloud Functions endpoints, `FunctionsUrlResolver` routes same-project `cloudfunctions.net` and loopback custom-domain URLs to `http(s)://<gateway>/<projectId>/<region>/<name>` and fails off-machine URLs immediately with `FirebaseFunctionsException.Code.UNAVAILABLE`. Verified in `packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt` and `packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt`.',
  tests: [
    'packages/kt-client/src/test/kotlin/dev/pyric/functions/FirebaseFunctionsTest.kt',
    'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FunctionsLiveHostConformanceTest.kt',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
