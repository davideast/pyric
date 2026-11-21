import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-swift',
  order: 40,
  defaults: {
    section: 'Cross-Service Token Attachment & Error Mapping',
  },
});

export const row = bindSwiftAppCheckRow(section);
