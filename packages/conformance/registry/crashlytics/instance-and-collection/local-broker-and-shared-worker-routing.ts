import {
  LIVE_HOST_CONFORMANCE_TEST,
  LIVE_HOSTED_BROWSER_E2E_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'pyric/crashlytics local CrashlyticsBroker and SharedWorker transport',
  behavior:
    'Routes logs, error reports, and flush calls into the per-sandbox CrashlyticsBroker (directly or over the served SharedWorker / HostedRuntime WebSocket bridge) instead of exporting OpenTelemetry OTLP payloads to clienttelemetry.googleapis.com/v1/logs or regional clienttelemetry.<region>.rep.googleapis.com/v1/logs endpoints.',
  featureKeys: ['CrashlyticsClientTransport', 'createTransportCrashlytics'],
  status: 'diverged-documented',
  statusNote: 'local CrashlyticsBroker routing',
  oracleObservations: ['crashlytics-web-otlp-endpoints-and-attributes'],
  evidence:
    'Upstream OTLP ingestion contract captured in `crashlytics-web-otlp-endpoints-and-attributes`; `pyric/crashlytics` intentionally keeps all telemetry inside `CrashlyticsBroker` and `/__pyric/sandbox` with zero external egress, verified in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/cli/test/serve/crashlytics-bridge.test.ts`, and `packages/cli/test/e2e/hosted/crashlytics-hosted.pw.ts`.',
  tests: [
    'packages/pyric/test/crashlytics/crashlytics.test.ts',
    ORACLE_REPLAY_TEST,
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [
    LIVE_HOST_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
});
