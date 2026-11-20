import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 50,
  defaults: {
    section: 'Snapshots & metadata',
  },
});

export const row = bindFlutterFirestoreRow(section);
