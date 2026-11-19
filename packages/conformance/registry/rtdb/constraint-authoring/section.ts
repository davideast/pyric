import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb',
  order: 30,
  publishInCompatibilityDocs: false,
  defaults: {
    section: "Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)",
    api: "Constraint authoring surface (`atoms` / `policies` / `compose` / `ruleset`)",
    status: "conforms",
    automation: "oracle-backed",
  },
});

export const row = section.row;
