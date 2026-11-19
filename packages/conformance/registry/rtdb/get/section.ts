import { cddLifecycleTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 100,
  prefix: "### `get(ref)` — single read\n",
  defaults: {
    featureKeys: ["get"],
    section: "Public API",
    api: "Public API",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: cddLifecycleTests,
  },
});

export const row = section.row;
