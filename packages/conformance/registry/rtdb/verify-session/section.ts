import { defineRowSection } from '../../section-rows.ts';

/** What `pyric verify` checks when it replays a captured RTDB session under candidate rules. */
export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 80,
  publishInCompatibilityDocs: false,
  prefix: "### Verifying a captured session\n\n`pyric verify` replays a session the sandbox captured (`.pyric/last-session.json`) under candidate rules and reports where they decide an operation differently from the rules the session ran with. Each row here states which captured operations it checks and what it reports. Verdicts come from the sandbox's RTDB rules engine, the same evaluator that enforced the session; no production engine checks them.\n",
  defaults: {
    section: "Verifying a captured session",
    status: "conforms",
    automation: "oracle-backed",
  },
});

export const row = section.row;
