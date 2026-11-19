import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 40,
  defaults: {
    featureKeys: ["signInWithEmailAndPassword"],
    section: "`signInWithEmailAndPassword(auth, email, password)` — password",
    api: "signInWithEmailAndPassword(auth, email, password)",
  },
});

export const row = section.row;
