import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "firestore-rules",
  order: 10,
  prefix: "## Firestore rules engine — production simulator conformance (rules-firestore corpus)\n",
  defaults: {
    section: "Rules engine — production simulator conformance (rules-firestore corpus)",
    api: "Rules simulator",
    automation: "oracle-backed",
    conformanceTests: ["packages/pyric/test/rules/oracle-conformance.test.ts"],
  },
});

export const row = section.row;
