import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 10,
  defaults: {
    featureKeys: ["getAuth"],
    section: "`getAuth(target)` — initializer",
    api: "getAuth(target)",
  },
});

export const row = section.row;
