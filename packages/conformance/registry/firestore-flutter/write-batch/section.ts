import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-flutter',
  order: 60,
  defaults: {
    section: '`WriteBatchPlatform` \u2014 atomic batches',
  },
});

export const row = bindFlutterFirestoreRow(section);
