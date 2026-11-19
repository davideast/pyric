import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 50,
  prefix: "## Public API\n\n`pyric/database` mirrors the public `firebase/database` API in the Pyric sandbox. The rows below compare its observable behaviour with Firebase.\n",
  defaults: {
    section: "Public API",
    api: "Public API",
  },
});

export const row = section.row;
