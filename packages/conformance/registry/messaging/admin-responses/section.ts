import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 80,
  defaults: {
    section: 'Response shapes',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
