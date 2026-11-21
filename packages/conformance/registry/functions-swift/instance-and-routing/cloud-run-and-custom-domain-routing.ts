import { row } from './section.ts';

export default row({
  order: 40,
  api: 'FunctionsURLResolver Cloud Run (*.a.run.app / *.run.app) & customDomain routing',
  behavior: 'Rewrites legacy *.a.run.app and regional *.run.app URLs onto the local gateway with ?__pyric_run_service=1 and routes loopback customDomain Hosting rewrites.',
  featureKeys: ['customDomain', '__pyric_run_service'],
  evidence: 'Verified in `packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift` (hermeticTargetRoutingAndOffMachineGuard).',
  tests: [
    'packages/swift-client/Tests/PyricFunctionsTests/PyricFunctionsUnitTests.swift',
  ],
});
