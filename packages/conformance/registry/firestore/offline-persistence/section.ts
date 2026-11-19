import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 220,
  prefix: '## Offline / persistence / network family (continued)\n',
  defaults: {
    section: "Offline / persistence / network family",
    automation: "unit-backed",
  },
});

export const row = section.row;
