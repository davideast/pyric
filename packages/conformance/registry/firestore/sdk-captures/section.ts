import { defineRowSection } from '../../section-rows.ts';

/**
 * Rows backed by the 2026-10-27 SDK behavior hunt's production captures. Each
 * observation comes from a scenario in `src/capture/sdk-scenarios/firestore/`,
 * and the pyric suites replay the same scenario. A `bug` row's test pins both
 * answers under the hunt's finding ID until its fix stream removes the pin.
 */
export const IN_PAGE = 'packages/pyric/test/firestore/oracle-captures';
export const SERVED = 'packages/cli/test/serve/worker/oracle-captures';

export const section = defineRowSection({
  surface: 'firestore',
  order: 290,
  prefix: '## Behavior checked against production captures\n\nEach row cites a production capture from the SDK behavior hunt. A `bug` row states production\'s behavior and pyric\'s; its test holds both answers until the fix lands.\n',
  defaults: {
    section: 'Behavior checked against production captures',
    status: 'conforms',
    automation: 'oracle-backed',
  },
});

export const row = section.row;

export const captureRow: typeof section.row = (seed) =>
  section.row({
    status: 'bug',
    conformanceDisposition: 'pending-fix',
    ...seed,
  });
