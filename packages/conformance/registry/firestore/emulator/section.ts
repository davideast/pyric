import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 200,
  defaults: {
    featureKeys: ["connectFirestoreEmulator"],
    section: "`connectFirestoreEmulator`",
    api: "connectFirestoreEmulator",
    status: "conforms",
  },
});

export const row = section.row;
