import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 70,
  defaults: {
    featureKeys: ["onAuthStateChanged"],
    section: "`onAuthStateChanged(auth, observer)`",
    api: "onAuthStateChanged(auth, observer)",
    status: "conforms",
  },
});

export const row = section.row;
