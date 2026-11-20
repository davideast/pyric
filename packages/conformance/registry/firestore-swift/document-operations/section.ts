import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 20,
  defaults: {
    section: '`DocumentReference` \u2014 document operations',
  },
});

export const row = bindSwiftFirestoreRow(section);
