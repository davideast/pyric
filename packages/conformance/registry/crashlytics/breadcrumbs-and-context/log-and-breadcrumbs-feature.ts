import {
  LIVE_HOST_CONFORMANCE_TEST,
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'log(crashlytics, message, attributes?) / breadcrumbs()',
  behavior:
    'Appends timestamped log entries to the 256-entry per-app ring buffer, merges call-level Attributes over CrashlyticsOptions.customAttributes, and buffers breadcrumbs onto the next error report before clearing the breadcrumb buffer when breadcrumbs() is enabled.',
  featureKeys: ['log', 'breadcrumbs', 'CrashlyticsFeature', 'Attributes'],
  status: 'conforms',
  oracleObservations: [
    'crashlytics-web-otlp-endpoints-and-attributes',
    'crashlytics-web-browser-lifecycle-and-breadcrumbs',
  ],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.breadcrumbs-buffer-and-clear',
      observation: 'crashlytics-web-browser-lifecycle-and-breadcrumbs',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'breadcrumbs() buffers log records until recordError fires and clears the buffer afterward',
      expect: {
        requestCountBeforeError: 0,
        clearsBreadcrumbsAfterRecordError: true,
      },
    },
  ],
  evidence:
    'Captured against `@firebase/crashlytics@0.2.0` (`crashlytics-web-otlp-endpoints-and-attributes`, `crashlytics-web-browser-lifecycle-and-breadcrumbs`) and verified in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/conformance/test/src/capture/crashlytics-web/oracle-replay.test.ts`, and `packages/cli/test/serve/crashlytics-bridge.test.ts`.',
  tests: [
    'packages/pyric/test/crashlytics/crashlytics.test.ts',
    ORACLE_REPLAY_TEST,
    LIVE_HOST_CONFORMANCE_TEST,
    LIVE_WEB_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [
    LIVE_HOST_CONFORMANCE_TEST,
    LIVE_WEB_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
});
