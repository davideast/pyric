import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 60,
  defaults: {
    section: '`WriteBatch` \u2014 atomic batches',
  },
});

export const row = bindKotlinFirestoreRow(section);
