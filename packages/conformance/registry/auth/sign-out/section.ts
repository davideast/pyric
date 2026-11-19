import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 60,
  defaults: {
    featureKeys: ["signOut"],
    section: "`signOut(auth)`",
    api: "signOut(auth)",
  },
});

export const row = section.row;
