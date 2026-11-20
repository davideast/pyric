import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 70,
  defaults: {
    section: "Query Ordering, Filtering & Limits",
  },
});

export const row = bindKotlinRtdbRow(section);
