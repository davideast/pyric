import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-kotlin',
  order: 50,
  defaults: {
    section: 'Send Plane, Analytics & Error Mapping',
  },
});

export const row = bindKotlinMessagingRow(section);
