import {
  LIVE_HOST_CONFORMANCE_TEST,
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'flush(crashlytics) / crashlytics.flush / crashlytics.getState',
  behavior:
    'Drains all in-flight client log and recordError promises before marking queued reports flushed: true on CrashlyticsBroker and exposing inspectable per-app logs, reports, and unsentReports via crashlytics.getState.',
  featureKeys: ['flush', 'CrashlyticsAppState', 'CrashlyticsReport'],
  status: 'conforms',
  oracleObservations: ['crashlytics-web-otlp-endpoints-and-attributes'],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.flush-drains-queued-records',
      observation: 'crashlytics-web-otlp-endpoints-and-attributes',
      probe: ORACLE_REPLAY_TEST,
      guards: 'flush drains queued logs and errors and leaves global logger provider untouched by default',
      expect: {
        defaultLeavesGlobalProviderUnchanged: true,
        globalProviderRegistered: true,
      },
    },
  ],
  evidence:
    'Captured against `@firebase/crashlytics@0.2.0` (`crashlytics-web-otlp-endpoints-and-attributes`) and verified in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/conformance/test/src/capture/crashlytics-web/oracle-replay.test.ts`, and `packages/cli/test/serve/crashlytics-bridge.test.ts`.',
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
