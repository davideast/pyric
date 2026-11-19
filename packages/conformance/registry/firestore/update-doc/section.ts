import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 70,
  defaults: {
    featureKeys: ["updateDoc"],
    section: "`updateDoc(ref, data)` — partial write",
    api: "updateDoc(ref, data)",
    status: "conforms",
  },
});

export const row = section.row;
