import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 230,
  prefix: "### Transport, logging, and URL-reference exports\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    status: "diverged-documented",
    evidence: "`unit:modular/fruit-aliases.test.ts`",
    automation: "unit-backed",
    conformanceTests: ["packages/pyric/test/database/modular/fruit-aliases.test.ts"],
  },
});

export const row = section.row;
