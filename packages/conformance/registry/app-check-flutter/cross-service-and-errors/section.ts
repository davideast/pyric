import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-flutter',
  order: 40,
  defaults: {
    section: 'Cross-Service Token Attachment & Error Mapping',
  },
});

export const row = bindFlutterAppCheckRow(section);
