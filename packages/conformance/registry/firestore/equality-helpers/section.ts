import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 190,
  defaults: {
    section: "Equality helpers — `refEqual` / `queryEqual` / `snapshotEqual`",
    api: "Equality helpers",
  },
});

export const row = section.row;
