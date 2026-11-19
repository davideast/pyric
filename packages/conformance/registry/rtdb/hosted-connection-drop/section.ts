import { defineRowSection } from '../../section-rows.ts';

/** What a call in flight at a hosted socket drop does on the web hosted client (ADR-0019 decision 7). */
export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 240,
  prefix: "### Calls in flight when the hosted connection drops\n\nThe web hosted client talks to the Node host over one WebSocket. When that socket drops, a call the socket had already taken is in flight: the host may or may not have run it (ADR-0019 decision 7). Each row here states what becomes of such a call, against what the production Web SDK does when its own connection drops. The Node remote client (`remoteSandbox()`, used by `node --import @pyric/cli/register`) has its own socket to the host; row HD2 covers it.\n",
  defaults: {
    section: "Calls in flight when the hosted connection drops",
    status: "conforms",
    automation: "oracle-backed",
    oracleObservations: ["rtdb-modular-socket-drop-in-flight-fates"],
  },
});

export const row = section.row;
