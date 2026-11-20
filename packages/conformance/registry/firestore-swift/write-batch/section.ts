import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 60,
  defaults: {
    section: '`WriteBatch` \u2014 atomic batches',
  },
});

export const row = bindSwiftFirestoreRow(section);
