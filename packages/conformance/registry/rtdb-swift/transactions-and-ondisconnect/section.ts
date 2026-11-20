import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 80,
  defaults: {
    section: 'Transactions & OnDisconnect',
  },
});

export const row = bindSwiftRtdbRow(section);
