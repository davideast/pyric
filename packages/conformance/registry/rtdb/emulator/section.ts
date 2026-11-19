import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 220,
  publishInCompatibilityDocs: false,
  prefix: "### `connectDatabaseEmulator` — emulator hook\n",
  defaults: {
    featureKeys: ["connectDatabaseEmulator"],
    section: "Public API",
    api: "Public API",
    status: "unsupported",
    evidence: "Phase 3",
    automation: "unsupported",
    exceptionReason: "unsupported / intentionally out of scope",
  },
});

export const row = section.row;
