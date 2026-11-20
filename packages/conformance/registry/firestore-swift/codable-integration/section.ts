import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 110,
  defaults: {
    section: 'Codable integration',
  },
});

export const row = bindSwiftFirestoreRow(section);
