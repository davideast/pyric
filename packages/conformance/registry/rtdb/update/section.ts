import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 120,
  prefix: "### `update(ref, values)` — partial / multi-path update\n",
  defaults: {
    featureKeys: ["update"],
    section: "Public API",
    api: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
