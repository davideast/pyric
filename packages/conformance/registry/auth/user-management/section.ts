import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 160,
  defaults: {
    section: "User-management and session exports",
    automation: "unit-backed",
  },
});

export const row = section.row;
