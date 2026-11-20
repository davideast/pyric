import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 30,
  defaults: {
    section: "Write Operations",
  },
});

export const row = bindKotlinRtdbRow(section);
