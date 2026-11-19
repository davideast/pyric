import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 50,
  defaults: {
    featureKeys: ["createUserWithEmailAndPassword"],
    section: "`createUserWithEmailAndPassword(auth, email, password)` — register",
    api: "createUserWithEmailAndPassword(auth, email, password)",
    status: "conforms",
  },
});

export const row = section.row;
