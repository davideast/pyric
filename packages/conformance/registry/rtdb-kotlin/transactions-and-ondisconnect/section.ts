import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 80,
  defaults: {
    section: "Transactions & OnDisconnect",
  },
});

export const row = bindKotlinRtdbRow(section);
