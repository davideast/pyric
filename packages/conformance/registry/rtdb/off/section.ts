import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 170,
  prefix: "### `off(ref, eventType?, callback?)` — unsubscribe variants\n",
  defaults: {
    featureKeys: ["off"],
    section: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
