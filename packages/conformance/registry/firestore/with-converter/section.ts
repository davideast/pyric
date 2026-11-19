import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 100,
  defaults: {
    featureKeys: ["withConverter"],
    section: "`withConverter` — typed refs",
    api: "withConverter",
    status: "conforms",
    automation: "oracle-backed",
  },
});

export const row = section.row;
