import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-kotlin',
  order: 20,
  defaults: {
    section: 'Standard & Limited-Use Token Lifecycle',
  },
});

export const row = bindKotlinAppCheckRow(section);
