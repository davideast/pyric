import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 80,
  defaults: {
    section: '`FieldValue` \u2014 sentinels & transformations',
  },
});

export const row = bindKotlinFirestoreRow(section);
