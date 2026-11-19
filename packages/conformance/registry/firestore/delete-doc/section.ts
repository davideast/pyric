import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 80,
  defaults: {
    featureKeys: ["deleteDoc"],
    section: "`deleteDoc(ref)`",
    api: "deleteDoc(ref)",
    status: "conforms",
  },
});

export const row = section.row;
