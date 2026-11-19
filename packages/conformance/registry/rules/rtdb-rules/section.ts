import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "rtdb-rules",
  order: 30,
  defaults: {
    section: "RTDB rules engine — production simulator conformance (rules-rtdb corpus)",
    api: "Rules simulator",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts"],
  },
});

export const row = section.row;
