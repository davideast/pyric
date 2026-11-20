import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 70,
  defaults: {
    section: '`Transaction` \u2014 interactive transactions',
  },
});

export const row = bindSwiftFirestoreRow(section);
