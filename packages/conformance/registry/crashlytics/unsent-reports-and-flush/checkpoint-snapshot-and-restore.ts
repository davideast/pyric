import {
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  api: 'CrashlyticsBroker.snapshot() / restore(raw) / captureFullState & applyFullState',
  behavior:
    'Registers CrashlyticsBroker as a persistable sandbox service so per-app reports, unsent queues, logs, customKeys, and userId round-trip across captureFullState and applyFullState checkpoints.',
  featureKeys: ['CrashlyticsSnapshot', 'getCrashlyticsBroker'],
  status: 'bug',
  statusNote:
    'captureFullState omits crashlytics and applyFullState resets CrashlyticsBroker; validatePersistedService rejects persisted crashlytics on SQLite HostedRuntime restart',
  evidence:
    'In-memory `CrashlyticsBroker.snapshot()` / `restore(raw)` round-trips across `MemoryBackend` hosts, but live `HostedRuntime` `sandbox.checkpoint` / `sandbox.restore` (`captureFullState` / `applyFullState`) resets `CrashlyticsBroker` and `validatePersistedService` rejects `"crashlytics"` on SQLite restart; reproduced in `packages/cli/test/serve/crashlytics-web-conformance.test.ts` and `packages/cli/test/e2e/hosted/crashlytics-hosted.pw.ts`.',
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
