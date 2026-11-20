import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 10,
  defaults: {
    section: "Database Instance & Connection",
  },
});

export const row = bindKotlinRtdbRow(section);
