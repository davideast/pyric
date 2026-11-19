import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb',
  order: 20,
  publishInCompatibilityDocs: false,
  defaults: {
    featureKeys: ["simulateRtdbRules"],
    section: "`simulateRtdbRules(compiled, input)` — in-process rule evaluator",
    api: "simulateRtdbRules(compiled, input)",
  },
});

export const row = section.row;
