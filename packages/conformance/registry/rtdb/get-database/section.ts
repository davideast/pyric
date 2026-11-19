import { cddLifecycleTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 60,
  prefix: "### `getDatabase(target)` — initializer\n",
  defaults: {
    featureKeys: ["getDatabase"],
    section: "Public API",
    api: "Public API",
    conformanceTests: cddLifecycleTests,
  },
});

export const row = section.row;
