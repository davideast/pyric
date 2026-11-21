import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Auth ID token propagation (Authorization: Bearer) & secure transport guard',
  behavior: 'Resolves the signed-in Auth.auth(app:) user ID token onto Authorization: Bearer <idToken> over HTTPS or loopback HTTP while refusing unencrypted non-loopback credential transmission unless allowInsecureTokenAttachment is true.',
  featureKeys: ['Authorization: Bearer', 'allowInsecureTokenAttachment'],
  status: 'conforms',
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift` (fullLiveHostFunctionsWorkflow) and `packages/cli/test/serve/native-swift-functions-conformance.test.ts`.',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsLiveHostTests.swift',
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
