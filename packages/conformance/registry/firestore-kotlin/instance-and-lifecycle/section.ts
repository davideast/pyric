import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 10,
  defaults: {
    section: '`FirebaseFirestore` \u2014 instance & lifecycle',
  },
});

export const row = bindKotlinFirestoreRow(section);
