import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "auth",
  order: 20,
  defaults: {
    section: "Multi-app Auth session topology",
    status: "conforms",
    risk: ["stateful","listener"],
    riskScore: 4,
    automation: "oracle-backed",
  },
});

export const row = section.row;
