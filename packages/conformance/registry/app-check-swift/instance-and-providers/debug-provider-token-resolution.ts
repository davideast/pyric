import { row } from './section.ts';

export default row({
  order: 40,
  api: 'AppCheckDebugProvider.localDebugToken() / currentDebugToken()',
  behavior: 'Generates a stable per-app UUID debug token and resolves AppCheckDebugToken ahead of FIRAAppCheckDebugToken and localDebugToken().',
  featureKeys: ['AppCheckDebugProvider', 'localDebugToken', 'currentDebugToken'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (builtInProvidersAndDebugTokenPriority).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
  ],
});
