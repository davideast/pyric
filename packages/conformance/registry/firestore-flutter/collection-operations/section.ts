import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 40,
  defaults: {
    section: '`CollectionReferencePlatform` \u2014 collection operations',
  },
});

export const row = bindFlutterFirestoreRow(section);
