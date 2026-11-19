import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 40,
  defaults: {
    featureKeys: ["getDoc"],
    section: "`getDoc(ref)` — single-doc read",
    api: "getDoc(ref)",
  },
});

export const row = section.row;
