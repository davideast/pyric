import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 50,
  defaults: {
    featureKeys: ["getDocs"],
    section: "`getDocs(query)` — bulk read",
    api: "getDocs(query)",
    automation: "unit-backed",
  },
});

export const row = section.row;
