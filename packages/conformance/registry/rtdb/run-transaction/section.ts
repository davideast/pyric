import { cddPublicOperationTests } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-modular',
  order: 200,
  prefix: "### `runTransaction(ref, transactionUpdate, options?)` — optimistic concurrency\n",
  defaults: {
    featureKeys: ["runTransaction"],
    section: "Public API",
    api: "Public API",
    conformanceTests: cddPublicOperationTests,
  },
});

export const row = section.row;
