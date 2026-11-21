import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-kotlin',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Permissions & Settings',
  },
});

export const row = bindKotlinMessagingRow(section);
