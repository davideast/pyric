import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 90,
  defaults: {
    featureKeys: ["setPersistence"],
    section: "`setPersistence(auth, persistence)`",
    api: "setPersistence(auth, persistence)",
  },
});

export const row = section.row;
