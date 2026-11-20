import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 50,
  defaults: {
    section: "One-Shot Reads & DataSnapshot Inspection",
  },
});

export const row = bindKotlinRtdbRow(section);
