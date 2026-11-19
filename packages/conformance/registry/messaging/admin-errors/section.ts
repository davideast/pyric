import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 90,
  defaults: {
    section: 'Errors',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
