import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'HostedRuntime live-mode mutating crashlytics.* refusal (PYRIC_LIVE_REFUSED)',
  behavior:
    'Refuses mutating crashlytics.* operations with PYRIC_LIVE_REFUSED when ownWriteRefusal is active on a live-mode host while still permitting read-only checkForUnsentReports and getState inspection.',
  featureKeys: ['CrashlyticsLiveModeGuard'],
  status: 'conforms',
  evidence:
    'Verified in `packages/cli/test/serve/crashlytics-bridge.test.ts` (`refuses mutating crashlytics ops on a live-mode host while allowing read-only state inspection`).',
  tests: [LIVE_HOST_CONFORMANCE_TEST],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
