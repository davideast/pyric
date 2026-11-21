import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-flutter',
  order: 50,
  defaults: {
    section: 'Send Plane, Analytics & Error Mapping',
  },
});

export const row = bindFlutterMessagingRow(section);
