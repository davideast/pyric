import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 140,
  defaults: {
    featureKeys: ["onSnapshot"],
    section: "`onSnapshot(refOrQuery, …)` — listeners",
    api: "onSnapshot(refOrQuery, …)",
    status: "conforms",
  },
});

export const row = section.row;
