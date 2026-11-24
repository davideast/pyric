import {
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'CrashlyticsOptions.endpointUrl loopback and local-path enforcement',
  behavior:
    'Accepts loopback (127.0.0.1, localhost, [::1]) and relative local paths in CrashlyticsOptions.endpointUrl while synchronously refusing external or empty URLs with FirebaseError("crashlytics/invalid-endpoint") across in-process and served HostedRuntime entrypoints.',
  featureKeys: ['validateCrashlyticsEndpointUrl'],
  status: 'conforms',
  oracleObservations: ['crashlytics-web-otlp-endpoints-and-attributes'],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.loopback-endpoint-guard',
      observation: 'crashlytics-web-otlp-endpoints-and-attributes',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'loopback endpointUrl is accepted while external clienttelemetry endpoints are refused with crashlytics/invalid-endpoint',
      expect: {
        customEndpointNormalizedUrl: 'http://127.0.0.1:4318/v1/logs',
      },
    },
  ],
  evidence:
    'Loopback `endpointUrl` contract captured in `crashlytics-web-otlp-endpoints-and-attributes` and verified across in-process, served `HostedRuntime`, and headless Chromium in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/cli/test/serve/crashlytics-web-conformance.test.ts`, and `packages/cli/test/e2e/hosted/crashlytics-hosted.pw.ts`.',
  tests: [
    'packages/pyric/test/crashlytics/crashlytics.test.ts',
    ORACLE_REPLAY_TEST,
    LIVE_WEB_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
  hostConformanceTests: [
    LIVE_WEB_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
});
