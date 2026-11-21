import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-swift',
  order: 20,
  defaults: {
    section: 'FCM Token Lifecycle & Registration',
  },
});

export const row = bindSwiftMessagingRow(section);
