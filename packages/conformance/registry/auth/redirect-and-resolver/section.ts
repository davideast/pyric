import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 110,
  defaults: {
    section: "`signInWithRedirect` / `getRedirectResult` / resolver seam",
    api: "signInWithRedirect` / `getRedirectResult` / resolver seam",
    status: "conforms",
    evidence: "`unit:sandbox-resolver.test.ts`",
    automation: "unit-backed",
    conformanceTests: ["packages/pyric/test/auth/sandbox-resolver.test.ts"],
  },
});

export const row = section.row;
