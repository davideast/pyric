import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingBehaviorRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 100,
  defaults: {
    section: 'Behavior classes — quota, retry, offline delivery (send plane)',
  },
});

export const row = bindMessagingBehaviorRow(section);
