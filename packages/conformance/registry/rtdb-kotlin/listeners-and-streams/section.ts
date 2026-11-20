import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 60,
  defaults: {
    section: "Realtime Listeners & Streams",
  },
});

export const row = bindKotlinRtdbRow(section);
