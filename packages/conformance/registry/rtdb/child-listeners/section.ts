import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 160,
  prefix: "### `onChildAdded` / `onChildChanged` / `onChildRemoved` / `onChildMoved`\n",
  defaults: {
    section: "Public API",
    api: "Public API",
    automation: "oracle-backed",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
