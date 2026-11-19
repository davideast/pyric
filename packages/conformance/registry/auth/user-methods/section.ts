import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 140,
  defaults: {
    section: "`User` methods",
  },
});

export const row = section.row;
