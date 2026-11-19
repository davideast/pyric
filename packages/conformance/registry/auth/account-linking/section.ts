import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 180,
  defaults: {
    section: "`linkWithCredential` / `linkWithPopup` / `linkWithRedirect` / `unlink` — account linking",
    status: "conforms",
  },
});

export const row = section.row;
