import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 20,
  defaults: {
    section: '`DocumentReference` \u2014 document operations',
  },
});

export const row = bindKotlinFirestoreRow(section);
