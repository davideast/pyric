import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 170,
  defaults: {
    section: "`ActionCodeURL` / email-link / action-code — the out-of-band family",
  },
});

export const row = section.row;
