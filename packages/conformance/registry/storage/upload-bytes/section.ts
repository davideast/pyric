import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 30,
  defaults: {
    featureKeys: ["uploadBytes"],
    section: "`uploadBytes(ref, data, metadata?)` — write blob",
    api: "uploadBytes(ref, data, metadata?)",
    status: "conforms",
    automation: "oracle-backed",
  },
});

export const row = section.row;
