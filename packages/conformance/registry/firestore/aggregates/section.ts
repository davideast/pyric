import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 130,
  defaults: {
    section: "Aggregates — `getCountFromServer` / `getAggregateFromServer` / `count` / `sum` / `average`",
    api: "Aggregates",
  },
});

export const row = section.row;
