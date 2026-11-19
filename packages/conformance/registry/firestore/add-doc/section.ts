import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 90,
  defaults: {
    featureKeys: ["addDoc"],
    section: "`addDoc(coll, data)` — auto-id write",
    api: "addDoc(coll, data)",
  },
});

export const row = section.row;
