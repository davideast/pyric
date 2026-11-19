import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 190,
  prefix: "### Sentinels — `serverTimestamp()` / `increment(n)`\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
