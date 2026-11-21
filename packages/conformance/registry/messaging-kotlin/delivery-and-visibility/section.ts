import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-kotlin',
  order: 40,
  defaults: {
    section: 'Foreground & Background Delivery Routing',
  },
});

export const row = bindKotlinMessagingRow(section);
