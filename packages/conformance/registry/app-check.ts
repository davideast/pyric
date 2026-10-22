import { defineRows } from './define-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The app-check surface registry, admitted at zero under Conformance Driven
 * Development (docs/conformance/cdd.md).
 *
 * `pyric/app-check` is a deferred stub today: every upstream name resolves and
 * throws `PyricDeferredApiError`. The production captures under the
 * `app-check-` prefix (rig `rigs/app-check.ts`) are parked in `exceptions/`
 * until rows cite them. Every row here is born status 'unverified' and
 * automation 'unverified'. The capture plan is
 * packages/conformance/docs/app-check/capture-plan.md.
 */

const row = defineRows({
  surface: 'app-check',
  defaults: { status: 'unverified' as const, automation: 'unverified' as const },
});

const SEC_INIT = '`initializeAppCheck(app, options)` and tokens';

const initRows: CompatibilityRow[] = [
  row({
    rowRef: 'initialize-and-get-token',
    featureKeys: ['initializeAppCheck', 'getToken'],
    section: SEC_INIT,
    api: 'initializeAppCheck(app, { provider }); getToken(appCheck, forceRefresh?)',
    behavior:
      '`initializeAppCheck` activates App Check for the app with an attestation provider, and `getToken` resolves with an `AppCheckTokenResult` whose `token` is the App Check JWT that Firebase SDKs attach to requests.',
    evidence:
      'Upstream documentation only (firebase 12.13.0 typings and the App Check web guide). The sandbox mirror is a deferred stub that throws; no capture is cited yet.',
  }),
];

export const appCheckRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check',
  label: 'App Check',
  compatPath: 'packages/pyric/docs/app-check/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown:
        '# App Check compatibility\n\nApp Check is climbing under Conformance Driven Development. `pyric/app-check` is a deferred stub, so every row below is a target, not a guarantee.\n',
    },
    { kind: 'table', prefix: `## ${SEC_INIT}\n`, rows: initRows },
  ],
};
