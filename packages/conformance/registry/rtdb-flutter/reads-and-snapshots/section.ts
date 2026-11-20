import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 50,
  defaults: {
    section: 'One-Shot Reads & DataSnapshot Inspection',
  },
});

export const row = bindFlutterRtdbRow(section);
