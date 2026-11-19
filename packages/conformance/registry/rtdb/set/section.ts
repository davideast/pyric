import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 110,
  prefix: "### `set(ref, value)` — full write\n",
  defaults: {
    featureKeys: ["set"],
    section: "Public API",
    api: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
