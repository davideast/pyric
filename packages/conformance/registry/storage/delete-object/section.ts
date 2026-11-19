import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 100,
  defaults: {
    featureKeys: ["deleteObject"],
    section: "`deleteObject(ref)` — delete",
    api: "deleteObject(ref)",
  },
});

export const row = section.row;
