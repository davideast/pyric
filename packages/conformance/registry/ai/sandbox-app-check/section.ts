import { defineRowSection } from '../../section-rows.ts';

/**
 * App Check in sandbox AI mode (#1291). AI Logic enforcement is required from
 * a date each project can set, up to January 21, 2027. The sandbox broker
 * refuses requests without a valid App Check token on every plane, whatever a
 * given unenforced project answers: in process (the in-page sandbox and a registered
 * Node process), and the worker broker behind the SharedWorker and the Node
 * host, which the claim reaches over the worker protocol. Handles with no app
 * (`getAI(sandbox)`, `createConfiguredSandboxAI`) are not gated: production
 * has no such handle.
 */
const SANDBOX_APP_CHECK_SUITE = 'packages/pyric/test/ai/app-check-gate.test.ts';
const SANDBOX_APP_CHECK_WORKER_SUITE = 'packages/cli/test/serve/worker/ai-ops.test.ts';
const SANDBOX_APP_CHECK_SCENARIO = 'test/apps/sandbox-app-check/scenario.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 150,
  defaults: {
    section: 'App Check in sandbox AI mode',
    status: 'conforms',
    automation: 'oracle-backed',
    conformanceTests: [SANDBOX_APP_CHECK_SUITE, SANDBOX_APP_CHECK_WORKER_SUITE, SANDBOX_APP_CHECK_SCENARIO],
  },
});

export const row = section.row;
