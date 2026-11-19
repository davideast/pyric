import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 170,
  defaults: {
    section: "Sentinels — `serverTimestamp` / `increment` / `arrayUnion` / `arrayRemove` / `deleteField` / `FieldValue` / `Timestamp`",
    api: "Sentinels",
    status: "conforms",
  },
});

export const row = section.row;
