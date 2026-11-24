import {
  LIVE_HOST_CONFORMANCE_TEST,
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'recordError(crashlytics, error, attributes?)',
  behavior:
    'Normalizes Error (name, message, stack or "No stack trace available", code, and chained cause), string, and non-Error values ("Unknown error type: <typeof>"), merges call-level attributes over base customAttributes, attaches and clears buffered breadcrumbs, and records sdkPlatform: "web" reports on CrashlyticsBroker.',
  featureKeys: ['recordError', 'CrashlyticsAttributes', 'AttributeValue'],
  status: 'conforms',
  oracleObservations: [
    'crashlytics-web-otlp-endpoints-and-attributes',
    'crashlytics-web-browser-lifecycle-and-breadcrumbs',
  ],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.recordError-otlp-and-attributes',
      observation: 'crashlytics-web-otlp-endpoints-and-attributes',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'recordError normalizes Error/string/non-Error payloads and applies call-level attribute precedence',
      expect: {
        globalEndpointUrl: 'https://clienttelemetry.googleapis.com/v1/logs',
        regionalEndpointUrl:
          'https://clienttelemetry.europe-west1.rep.googleapis.com/v1/logs',
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
