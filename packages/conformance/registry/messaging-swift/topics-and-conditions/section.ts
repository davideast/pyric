import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-swift',
  order: 30,
  defaults: {
    section: 'Topic Subscriptions & Condition Fanout',
  },
});

export const row = bindSwiftMessagingRow(section);
