import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 10,
  defaults: {
    section: 'Database Instance & Connection',
  },
});

export const row = bindSwiftRtdbRow(section);
