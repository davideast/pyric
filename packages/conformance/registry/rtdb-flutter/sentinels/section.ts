import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 40,
  defaults: {
    section: 'ServerValue Sentinels',
  },
});

export const row = bindFlutterRtdbRow(section);
