import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 20,
  defaults: {
    section: '`DocumentReferencePlatform` \u2014 document operations',
  },
});

export const row = bindFlutterFirestoreRow(section);
