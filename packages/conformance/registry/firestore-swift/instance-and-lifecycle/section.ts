import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 10,
  defaults: {
    section: '`Firestore` \u2014 instance & lifecycle',
  },
});

export const row = bindSwiftFirestoreRow(section);
