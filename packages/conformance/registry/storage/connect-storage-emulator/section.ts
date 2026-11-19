import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 140,
  defaults: {
    section: "`connectStorageEmulator(storage, host, port)` — emulator hook",
  },
});

export const row = section.row;
