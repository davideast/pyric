import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 100,
  defaults: {
    section: 'Aggregations & advanced queries',
  },
});

export const row = bindFlutterFirestoreRow(section);
