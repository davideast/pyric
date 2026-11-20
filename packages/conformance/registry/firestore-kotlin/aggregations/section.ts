import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 100,
  defaults: {
    section: 'Aggregations & advanced queries',
  },
});

export const row = bindKotlinFirestoreRow(section);
