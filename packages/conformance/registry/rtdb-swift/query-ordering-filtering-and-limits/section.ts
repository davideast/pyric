import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 70,
  defaults: {
    section: 'Query Ordering, Filtering & Limits',
  },
});

export const row = bindSwiftRtdbRow(section);
