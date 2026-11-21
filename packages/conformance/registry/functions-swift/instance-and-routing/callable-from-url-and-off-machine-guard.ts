import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'Functions.httpsCallable(_ url: URL, options:) / httpsCallable(URL:options:) & local gateway routing',
  behavior: 'Rewrites project cloudfunctions.net URLs onto the local Pyric Functions HTTP gateway while refusing foreign projects and off-machine origins with FunctionsErrorCode.unavailable before network I/O.',
  featureKeys: ['httpsCallable(URL:options:)', 'hermeticTargetRoutingAndOffMachineGuard'],
  status: 'diverged-documented',
  statusNote: 'local gateway & off-machine guard',
  evidence: 'Instead of sending HTTPS requests to external Cloud Functions endpoints, `FunctionsURLResolver` routes same-project `cloudfunctions.net` URLs to `http(s)://<gateway>/<projectID>/<region>/<name>` and fails off-machine URLs immediately with `FunctionsErrorCode.unavailable`. Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` and `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift`.',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
