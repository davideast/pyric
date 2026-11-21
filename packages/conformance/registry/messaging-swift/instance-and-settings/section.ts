import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-swift',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Permissions & Settings',
  },
});

export const row = bindSwiftMessagingRow(section);
