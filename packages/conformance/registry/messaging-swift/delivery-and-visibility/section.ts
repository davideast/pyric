import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-swift',
  order: 40,
  defaults: {
    section: 'Foreground & Background Delivery Routing',
  },
});

export const row = bindSwiftMessagingRow(section);
