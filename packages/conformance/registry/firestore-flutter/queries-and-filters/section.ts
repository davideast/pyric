import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 30,
  defaults: {
    section: '`QueryPlatform` \u2014 filters & constraints',
  },
});

export const row = bindFlutterFirestoreRow(section);
