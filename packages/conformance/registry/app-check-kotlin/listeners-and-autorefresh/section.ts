import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-kotlin',
  order: 30,
  defaults: {
    section: 'Token Listeners & Auto-Refresh',
  },
});

export const row = bindKotlinAppCheckRow(section);
