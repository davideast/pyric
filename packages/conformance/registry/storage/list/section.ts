import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 120,
  defaults: {
    section: "`list(ref, options?)` — paginated list",
  },
});

export const row = section.row;
