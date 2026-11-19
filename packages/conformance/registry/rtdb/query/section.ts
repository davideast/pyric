import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 180,
  prefix: "### `query(ref, ...constraints)` + ordering / bounds / limits\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
