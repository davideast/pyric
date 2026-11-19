import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb',
  order: 40,
  publishInCompatibilityDocs: false,
  defaults: {
    section: "Compiled RTDB rules tree ↔ rules JSON",
    status: "conforms",
    evidence: "`unit:compiled-rules.test.ts`",
    automation: "unit-backed",
    conformanceTests: ["packages/rules/test/rtdb/compiled-rules.test.ts"],
  },
});

export const row = section.row;
