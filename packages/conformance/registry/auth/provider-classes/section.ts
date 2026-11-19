import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 130,
  defaults: {
    section: "Provider classes (`GoogleAuthProvider`, `EmailAuthProvider`, etc.)",
    api: "Provider classes (`GoogleAuthProvider`, `EmailAuthProvider`, etc.)",
  },
});

export const row = section.row;
