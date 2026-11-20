import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 90,
  defaults: {
    section: 'Data types & value codecs',
  },
});

export const row = bindKotlinFirestoreRow(section);
