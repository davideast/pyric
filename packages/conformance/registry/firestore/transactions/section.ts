import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 150,
  defaults: {
    featureKeys: ["runTransaction"],
    section: "`runTransaction(db, fn)`",
    api: "runTransaction(db, fn)",
  },
});

export const row = section.row;
