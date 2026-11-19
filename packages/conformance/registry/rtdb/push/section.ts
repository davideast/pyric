import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 140,
  prefix: "### `push(ref, value?)` — auto-id append\n",
  defaults: {
    featureKeys: ["push"],
    section: "Public API",
    api: "Public API",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
