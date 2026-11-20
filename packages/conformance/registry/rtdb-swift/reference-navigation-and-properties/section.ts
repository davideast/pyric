import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 20,
  defaults: {
    section: 'DatabaseReference Navigation & Properties',
  },
});

export const row = bindSwiftRtdbRow(section);
