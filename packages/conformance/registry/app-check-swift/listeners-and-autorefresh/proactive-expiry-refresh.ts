import { row } from './section.ts';

export default row({
  order: 30,
  api: 'AppCheck background auto-refresh scheduler',
  behavior: 'Schedules background token renewal ahead of expirationDate (up to 5 minutes early) when isTokenAutoRefreshEnabled is true and posts AppCheckTokenDidChange.',
  featureKeys: ['autoRefreshRenewsExpiringToken'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift` (autoRefreshRenewsExpiringToken).',
  tests: [
    'packages/swift-client/Tests/PyricAppCheckTests/AppCheckUnitTests.swift',
  ],
});
