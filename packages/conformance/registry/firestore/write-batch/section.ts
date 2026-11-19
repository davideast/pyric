import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 160,
  defaults: {
    featureKeys: ["writeBatch"],
    section: "`writeBatch(db)`",
    api: "writeBatch(db)",
    status: "conforms",
  },
});

export const row = section.row;
