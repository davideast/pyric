import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 110,
  defaults: {
    featureKeys: ["listAll"],
    section: "`listAll(ref)` — list all children under a ref",
    api: "listAll(ref)",
    status: "conforms",
    automation: "oracle-backed",
  },
});

export const row = section.row;
