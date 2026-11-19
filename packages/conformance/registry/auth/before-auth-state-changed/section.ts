import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 150,
  defaults: {
    featureKeys: ["beforeAuthStateChanged"],
    section: "`beforeAuthStateChanged(auth, callback, onAbort?)`",
    api: "beforeAuthStateChanged(auth, callback, onAbort?)",
  },
});

export const row = section.row;
