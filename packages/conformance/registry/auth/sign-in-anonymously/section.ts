import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 30,
  defaults: {
    featureKeys: ["signInAnonymously"],
    section: "`signInAnonymously(auth)` — anonymous",
    api: "signInAnonymously(auth)",
  },
});

export const row = section.row;
