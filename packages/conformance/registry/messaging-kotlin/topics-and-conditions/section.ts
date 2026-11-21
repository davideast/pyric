import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-kotlin',
  order: 30,
  defaults: {
    section: 'Topic Subscriptions & Condition Fanout',
  },
});

export const row = bindKotlinMessagingRow(section);
