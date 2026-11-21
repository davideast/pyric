import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-kotlin',
  order: 40,
  defaults: {
    section: 'Cross-Service Token Attachment & Error Mapping',
  },
});

export const row = bindKotlinAppCheckRow(section);
