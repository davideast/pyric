import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 90,
  defaults: {
    section: "`getStream(ref, maxDownloadSize?)` — Node-specific",
  },
});

export const row = section.row;
