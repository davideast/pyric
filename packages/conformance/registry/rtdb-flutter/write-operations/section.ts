import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 30,
  defaults: {
    section: 'Write Operations',
  },
});

export const row = bindFlutterRtdbRow(section);
