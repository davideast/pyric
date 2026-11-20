import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 20,
  defaults: {
    section: 'DatabaseReference Navigation & Properties',
  },
});

export const row = bindFlutterRtdbRow(section);
