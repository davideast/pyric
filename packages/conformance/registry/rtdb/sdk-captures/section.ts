import { defineRowSection } from '../../section-rows.ts';

/**
 * Rows backed by the 2026-10-27 SDK behavior hunt's production captures on
 * the dedicated RTDB oracle instance. Each observation comes from a scenario
 * in `src/capture/sdk-scenarios/rtdb/`, and the CDD files
 * `packages/pyric/test/database/cdd/capture-*.test.ts` replay the same
 * scenario, one `row()` per row. A `bug` row's test pins both answers under
 * the hunt's finding ID until its fix stream removes the pin.
 */
export const CDD = 'packages/pyric/test/database/cdd';
export const SERVED = 'packages/cli/test/serve/worker/oracle-captures';
export const EVENT_ORDER = 'rtdb-modular-remote-update-event-order';
export const eventOrderTest = `${CDD}/capture-remote-update-event-order.test.ts`;

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 270,
  prefix: '## Behavior checked against production captures\n\nEach row cites a production capture from the SDK behavior hunt. A `bug` row states production\'s behavior and pyric\'s; its test holds both answers until the fix lands.\n',
  defaults: {
    section: 'Behavior checked against production captures',
    status: 'conforms',
    automation: 'oracle-backed',
  },
});

export const row = section.row;
