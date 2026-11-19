import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 240,
  prefix: '## Tier-1 cache-init + get-from-* family (continued)\n',
  defaults: {
    section: "Tier-1 cache-init + get-from-* family",
    evidence: "`unit:firestore/tier1-cache-init-align.test.ts`",
    automation: "unit-backed",
    conformanceTests: ["packages/pyric/test/firestore/tier1-cache-init-align.test.ts"],
  },
});

export const row = section.row;
