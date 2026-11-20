import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 10,
  defaults: {
    section: 'Database Instance & Connection',
  },
});

export const row = bindFlutterRtdbRow(section);
