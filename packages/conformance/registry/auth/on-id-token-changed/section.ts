import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 80,
  defaults: {
    featureKeys: ["onIdTokenChanged"],
    section: "`onIdTokenChanged(auth, observer)`",
    api: "onIdTokenChanged(auth, observer)",
    status: "conforms",
  },
});

export const row = section.row;
