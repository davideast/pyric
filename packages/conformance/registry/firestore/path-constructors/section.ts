import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 30,
  defaults: {
    section: "Path constructors — `doc` / `collection` / `collectionGroup`",
    api: "Path constructors",
    status: "conforms",
    automation: "unit-backed",
  },
});

export const row = section.row;
