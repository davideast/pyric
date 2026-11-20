import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 20,
  defaults: {
    section: "DatabaseReference Navigation & Properties",
  },
});

export const row = bindKotlinRtdbRow(section);
