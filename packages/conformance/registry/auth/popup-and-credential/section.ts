import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 100,
  defaults: {
    featureKeys: ["signInWithPopup","signInWithCredential"],
    section: "`signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)`",
    api: "signInWithPopup(auth, provider)` / `signInWithCredential(auth, credential)",
  },
});

export const row = section.row;
