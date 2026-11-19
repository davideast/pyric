import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 130,
  prefix: "### `remove(ref)` — delete\n",
  defaults: {
    featureKeys: ["remove"],
    section: "Public API",
    api: "Public API",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
