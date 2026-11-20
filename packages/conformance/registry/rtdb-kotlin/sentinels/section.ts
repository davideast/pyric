import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-kotlin',
  order: 40,
  defaults: {
    section: "ServerValue Sentinels",
  },
});

export const row = bindKotlinRtdbRow(section);
