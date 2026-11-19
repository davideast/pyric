import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 60,
  defaults: {
    featureKeys: ["getDownloadURL"],
    section: "`getDownloadURL(ref)` — read URL",
    api: "getDownloadURL(ref)",
    automation: "oracle-backed",
  },
});

export const row = section.row;
