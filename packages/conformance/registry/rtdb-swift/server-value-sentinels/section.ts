import { bindSwiftRtdbRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'rtdb-swift',
  order: 40,
  defaults: {
    section: 'ServerValue Sentinels',
  },
});

export const row = bindSwiftRtdbRow(section);
