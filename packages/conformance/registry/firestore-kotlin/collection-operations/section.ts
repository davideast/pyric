import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 40,
  defaults: {
    section: '`CollectionReference` \u2014 collection operations',
  },
});

export const row = bindKotlinFirestoreRow(section);
