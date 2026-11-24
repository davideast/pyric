import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'Inbound crashlytics.* worker-op schema validation',
  behavior:
    'Validates inbound crashlytics.* worker-op frames on HostedRuntime and rejects malformed parameter types with code: "invalid-argument" before mutating broker state.',
  featureKeys: ['CrashlyticsInboundValidation'],
  status: 'conforms',
  evidence:
    'Verified in `packages/cli/test/serve/crashlytics-bridge.test.ts` (`streams Web getCrashlytics -> log -> recordError -> flush and native 10-op wire lifecycle over HostedRuntime`).',
  tests: [LIVE_HOST_CONFORMANCE_TEST],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
