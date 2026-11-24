import {
  LIVE_HOST_CONFORMANCE_TEST,
  LIVE_HOSTED_BROWSER_E2E_TEST,
  LIVE_WEB_CONFORMANCE_TEST,
  ORACLE_REPLAY_TEST,
} from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  api: 'getCrashlytics(app?, options?) / firebase/crashlytics specifier mapping',
  behavior:
    'Caches per-FirebaseApp and per-Sandbox Crashlytics instances, enforces deep option equality across repeat calls (including breadcrumbs() { name: "breadcrumbs" } feature descriptors), and swaps firebase/crashlytics imports to pyric/crashlytics across register, Next.js aliases, import maps, and served SDK entries.',
  featureKeys: ['getCrashlytics', 'Crashlytics', 'CrashlyticsOptions'],
  status: 'conforms',
  oracleObservations: ['crashlytics-web-instance-and-options'],
  conformanceChecks: [
    {
      finding: 'crashlytics-web.getCrashlytics-option-equality',
      observation: 'crashlytics-web-instance-and-options',
      probe: ORACLE_REPLAY_TEST,
      guards:
        'getCrashlytics caches per-app singletons and throws on repeat-call option mismatch',
      expect: {
        breadcrumbFeatureName: 'breadcrumbs',
        defaultSameOmitted: true,
        omittedAfterOptionsError:
          'getCrashlytics() cannot be called with different options',
      },
    },
  ],
  evidence:
    'Captured against `@firebase/crashlytics@0.2.0` (`crashlytics-web-instance-and-options`) and verified in `packages/pyric/test/crashlytics/crashlytics.test.ts`, `packages/conformance/test/src/capture/crashlytics-web/oracle-replay.test.ts`, and `packages/cli/test/serve/crashlytics-bridge.test.ts`.',
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
