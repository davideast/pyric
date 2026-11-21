import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-swift',
  order: 50,
  defaults: {
    section: 'Send Plane, Analytics & Error Mapping',
  },
});

export const row = bindSwiftMessagingRow(section);
