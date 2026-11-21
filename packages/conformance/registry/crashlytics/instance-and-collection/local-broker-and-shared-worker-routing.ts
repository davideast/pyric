import { LIVE_HOST_CONFORMANCE_TEST } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: "pyric/crashlytics local CrashlyticsBroker and SharedWorker transport",
  behavior: "Routes logs, error reports, and flush calls into the per-sandbox CrashlyticsBroker (directly or over the served SharedWorker / HostedRuntime WebSocket bridge) instead of exporting OpenTelemetry OTLP payloads to firebasecrashlytics.googleapis.com.",
  featureKeys: ["CrashlyticsClientTransport", "createTransportCrashlytics"],
  status: "diverged-documented",
  statusNote: "local CrashlyticsBroker routing",
  evidence: "Instead of sending OTLP HTTP requests to external Crashlytics ingestion endpoints, `pyric/crashlytics` keeps all telemetry inside `CrashlyticsBroker` and `/__pyric/sandbox`. Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` and `packages/cli/test/serve/crashlytics-bridge.test.ts`.",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
    LIVE_HOST_CONFORMANCE_TEST,
  ],
  hostConformanceTests: [LIVE_HOST_CONFORMANCE_TEST],
});
