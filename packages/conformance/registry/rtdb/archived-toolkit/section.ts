import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb',
  order: 10,
  publishInCompatibilityDocs: false,
  prefix: "## Archived production-toolkit observations\n\nThese unsupported tombstones preserve immutable oracle `rowIds` for the removed host, REST, data, crawl, generation, and deployment toolkit. They are historical evidence, not current API claims.\n",
  defaults: {
    queryable: false,
    featureKeys: [],
    section: "Archived production toolkit",
    status: "unsupported",
    automation: "unsupported",
  },
});

export const row = section.row;
