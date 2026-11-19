import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging',
  order: 10,
  defaults: {
    section: '`firebase/messaging` (client)',
  },
});

export const row = bindMessagingCddRow('messaging', section);
