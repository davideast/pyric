import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 10,
  defaults: {
    section: '`FirebaseFirestorePlatform` \u2014 instance & lifecycle',
  },
});

export const row = bindFlutterFirestoreRow(section);
