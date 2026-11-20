import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 90,
  defaults: {
    section: 'Data types & value codecs',
  },
});

export const row = bindSwiftFirestoreRow(section);
