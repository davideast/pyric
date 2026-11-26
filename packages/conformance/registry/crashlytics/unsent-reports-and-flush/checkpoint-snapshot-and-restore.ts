import {
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'CrashlyticsBroker.snapshot() / restore(raw) / captureFullState & applyFullState',
  behavior:
    'Registers CrashlyticsBroker as a persistable sandbox service so per-app reports, unsent queues, logs, customKeys, and userId round-trip across captureFullState, applyFullState checkpoints, and SQLite HostedRuntime restarts.',
  featureKeys: ['CrashlyticsSnapshot', 'getCrashlyticsBroker'],
  status: 'conforms',
  evidence:
    'Verified across in-process checkpoints (`captureFullState`/`applyFullState`, `captureCheckpoint`/`restoreCheckpoint`), `validatePersistedService`/`persistedServiceHasData`, live `HostedRuntime` `sandbox.checkpoint`/`sandbox.restore`, and SQLite `HostedRuntime` restarts in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/cli/test/serve/crashlytics-web-conformance.test.ts`, and `packages/cli/test/e2e/hosted/crashlytics-hosted.pw.ts`.',
  tests: [
    'packages/pyric/test/crashlytics/crashlytics.test.ts',
    LIVE_WEB_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
  hostConformanceTests: [
    LIVE_WEB_CONFORMANCE_TEST,
    LIVE_HOSTED_BROWSER_E2E_TEST,
  ],
});
