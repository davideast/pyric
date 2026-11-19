import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 200,
  defaults: {
    section: "Constants, credentials, and inert config tokens",
  },
});

export const row = section.row;
