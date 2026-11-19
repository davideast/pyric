import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 260,
  prefix: '### Calls in flight when the hosted connection drops\n\nThe web hosted client talks to the Node host over one WebSocket. When that socket drops, a call the socket had already taken is in flight: the host may or may not have run it (ADR-0019 decision 7). Each row here states what becomes of such a call, against what the production Web SDK does when its own connection drops.\n',
  defaults: {
    section: "Calls in flight when the hosted connection drops",
    status: "diverged-documented",
    automation: "unit-backed",
  },
});

export const row = section.row;
