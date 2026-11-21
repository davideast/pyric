import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-flutter',
  order: 30,
  defaults: {
    section: 'Topic Subscriptions & Condition Fanout',
  },
});

export const row = bindFlutterMessagingRow(section);
