import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 130,
  defaults: {
    section: "`getMetadata(ref)` / `updateMetadata(ref, metadata)` — metadata ops",
    api: "getMetadata(ref)` / `updateMetadata(ref, metadata)",
  },
});

export const row = section.row;
