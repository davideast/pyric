import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 110,
  defaults: {
    section: "Query construction — `query` / `where` / `or` / `and` / `orderBy` / `limit`",
    api: "Query construction",
  },
});

export const row = section.row;
