import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 50,
  defaults: {
    section: '`Message` union + targets',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
