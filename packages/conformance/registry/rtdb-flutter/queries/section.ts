import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'rtdb-flutter',
  order: 70,
  defaults: {
    section: 'Query Ordering, Filtering & Limits',
  },
});

export const row = bindFlutterRtdbRow(section);
