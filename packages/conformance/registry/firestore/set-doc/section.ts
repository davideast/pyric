import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 60,
  defaults: {
    featureKeys: ["setDoc"],
    section: "`setDoc(ref, data[, options])` — full write",
    api: "setDoc(ref, data[, options])",
    status: "conforms",
  },
});

export const row = section.row;
