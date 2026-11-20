import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 70,
  defaults: {
    section: '`TransactionPlatform` \u2014 interactive transactions',
  },
});

export const row = bindFlutterFirestoreRow(section);
