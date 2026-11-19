import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 40,
  defaults: {
    section: '`firebase-admin/messaging` — entry + `Messaging` class',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
