import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging',
  order: 20,
  defaults: {
    section: '`firebase/messaging/sw` (service worker)',
  },
});

export const row = bindMessagingCddRow('messaging', section);
