import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-flutter',
  order: 20,
  defaults: {
    section: 'FCM Token Lifecycle & Registration',
  },
});

export const row = bindFlutterMessagingRow(section);
