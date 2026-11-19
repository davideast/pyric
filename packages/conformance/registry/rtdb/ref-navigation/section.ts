import { cddLifecycleTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 90,
  prefix: "### `ref(db, path)` / `child` / `parent` / `root`\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    conformanceTests: cddLifecycleTests,
  },
});

export const row = section.row;
