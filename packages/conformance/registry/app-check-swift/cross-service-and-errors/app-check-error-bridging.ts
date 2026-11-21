import { row } from './section.ts';

export default row({
  order: 20,
  api: 'AppCheckErrorCode / AppCheckErrorDomain',
  behavior: 'Maps unconfigured providers and bridge failures into AppCheckErrorCode (.unknown, .serverUnreachable, .invalidConfiguration, .keychain, .unsupported) with NSError domain com.firebase.appCheck and Swift catch pattern matching.',
  featureKeys: ['AppCheckErrorCode', 'AppCheckErrorDomain'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (bridgeWireOperationsAndErrorMapping).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
  ],
});
