import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterMessagingRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging-flutter',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Permissions & Settings',
  },
});

export const row = bindFlutterMessagingRow(section);
