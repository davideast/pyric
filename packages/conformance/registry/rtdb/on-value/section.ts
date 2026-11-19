import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 150,
  prefix: "### `onValue(ref, cb)` — value-level listener\n",
  defaults: {
    featureKeys: ["onValue"],
    section: "Public API",
    api: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
