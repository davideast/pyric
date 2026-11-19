import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 10,
  defaults: {
    featureKeys: ["getFirestore"],
    section: "`getFirestore(target)` — initializer",
    api: "getFirestore(target)",
    status: "conforms",
  },
});

export const row = section.row;
