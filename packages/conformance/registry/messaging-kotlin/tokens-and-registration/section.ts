import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-kotlin',
  order: 20,
  defaults: {
    section: 'FCM Token Lifecycle & Registration',
  },
});

export const row = bindKotlinMessagingRow(section);
