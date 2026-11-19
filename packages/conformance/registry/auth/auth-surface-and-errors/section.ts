import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 120,
  defaults: {
    featureKeys: ["Auth"],
    section: "`Auth` surface + error shape",
    api: "Auth` surface + error shape",
    status: "conforms",
    evidence: "`unit:auth-gap-surface.test.ts`",
    automation: "unit-backed",
    conformanceTests: ["packages/pyric/test/auth/auth-gap-surface.test.ts"],
  },
});

export const row = section.row;
