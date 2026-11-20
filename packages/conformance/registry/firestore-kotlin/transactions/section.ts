import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 70,
  defaults: {
    section: '`Transaction` \u2014 interactive transactions',
  },
});

export const row = bindKotlinFirestoreRow(section);
