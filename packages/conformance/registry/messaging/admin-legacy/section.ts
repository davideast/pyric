import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-admin',
  order: 70,
  defaults: {
    section: 'Legacy payload shapes',
  },
});

export const row = bindMessagingCddRow('messaging-admin', section);
