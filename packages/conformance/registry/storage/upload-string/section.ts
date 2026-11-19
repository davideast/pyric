import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 40,
  defaults: {
    featureKeys: ["uploadString"],
    section: "`uploadString(ref, value, format?, metadata?)` — write string-form",
    api: "uploadString(ref, value, format?, metadata?)",
  },
});

export const row = section.row;
