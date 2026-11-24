import {
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'captureUnhandledErrors (window error & unhandledrejection) / app/app-deleted guard',
  behavior:
    'Captures unhandled window error and unhandledrejection events as fatal: true reports when captureUnhandledErrors !== false, deduplicates errors already passed to recordError, detaches listeners and shuts down pre-existing handles as silent no-ops on deleteApp(), and rejects fresh getCrashlytics(deletedApp) calls with FirebaseError("app/app-deleted").',
  featureKeys: ['CrashlyticsOptions.captureUnhandledErrors'],
  status: 'conforms',
  oracleObservations: ['crashlytics-web-browser-lifecycle-and-breadcrumbs'],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.unhandled-errors-and-deleteApp',
      observation: 'crashlytics-web-browser-lifecycle-and-breadcrumbs',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'unhandled window errors deduplicate ALREADY_LOGGED_FLAG, shut-down handles no-op after deleteApp, and fresh getCrashlytics(deletedApp) throws app/app-deleted',
      expect: {
        deduplicatesAlreadyLoggedUnhandledError: true,
        shutDownHandleNoOpsAfterDeleteApp: true,
        getCrashlyticsOnFreshDeletedCode: 'app/app-deleted',
      },
    },
  ],
  evidence:
    'Captured against `@firebase/crashlytics@0.2.0` (`crashlytics-web-browser-lifecycle-and-breadcrumbs`) and verified against live `HostedRuntime` and headless Chromium in `packages/cli/test/serve/crashlytics-web-conformance.test.ts` and `packages/cli/test/e2e/hosted/crashlytics-hosted.pw.ts`.',
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
