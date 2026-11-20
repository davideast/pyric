import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 30,
  defaults: {
    section: 'Write Operations',
  },
});

export const row = bindSwiftRtdbRow(section);
