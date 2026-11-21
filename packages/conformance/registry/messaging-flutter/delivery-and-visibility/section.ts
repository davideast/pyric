import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-flutter',
  order: 40,
  defaults: {
    section: 'Foreground & Background Delivery Routing',
  },
});

export const row = bindFlutterMessagingRow(section);
