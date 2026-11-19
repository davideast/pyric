import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 60,
  defaults: {
    section: 'Payload / config option shapes',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
