import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 50,
  defaults: {
    section: 'One-Shot Reads & DataSnapshot Inspection',
  },
});

export const row = bindSwiftRtdbRow(section);
