import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 90,
  defaults: {
    section: 'Data types & value codecs',
  },
});

export const row = bindFlutterFirestoreRow(section);
