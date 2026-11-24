import {
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  api: 'Automatic popstate, hashchange, and visibilitychange breadcrumbs',
  behavior:
    'Records navigation:<pathname> and visibility:<state> breadcrumbs when breadcrumbs() is enabled in CrashlyticsOptions.features, auto-flushes queued telemetry on visibilityState === "hidden" and pagehide, and detaches DOM listeners on deleteApp().',
  featureKeys: ['CrashlyticsOptions.features'],
  status: 'conforms',
  oracleObservations: ['crashlytics-web-browser-lifecycle-and-breadcrumbs'],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.visibility-auto-flush-and-teardown',
      observation: 'crashlytics-web-browser-lifecycle-and-breadcrumbs',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'visibilitychange logs lifecycle breadcrumbs, auto-flushes on hidden, and detaches on deleteApp',
      expect: {
        autoFlushesOnVisibilityHidden: true,
        listenersAfterDelete: {
          load: 0,
          pagehide: 0,
          visibilitychange: 0,
          error: 0,
          unhandledrejection: 0,
        },
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
