import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 190,
  defaults: {
    section: "`reauthenticateWithCredential` / `reauthenticateWithPopup` / `reauthenticateWithRedirect` — re-authentication",
    automation: "unit-backed",
    conformanceTests: ["packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
  },
});

export const row = section.row;
