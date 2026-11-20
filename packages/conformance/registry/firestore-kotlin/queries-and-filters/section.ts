import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-kotlin',
  order: 30,
  defaults: {
    section: '`Query` \u2014 filters & constraints',
  },
});

export const row = bindKotlinFirestoreRow(section);
