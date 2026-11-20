import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 80,
  defaults: {
    section: 'Transactions & OnDisconnect',
  },
});

export const row = bindFlutterRtdbRow(section);
