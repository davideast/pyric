import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 60,
  defaults: {
    section: 'Realtime Listeners & Streams',
  },
});

export const row = bindFlutterRtdbRow(section);
