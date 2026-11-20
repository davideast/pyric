import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 80,
  defaults: {
    section: '`FieldValuePlatform` \u2014 sentinels & transformations',
  },
});

export const row = bindFlutterFirestoreRow(section);
