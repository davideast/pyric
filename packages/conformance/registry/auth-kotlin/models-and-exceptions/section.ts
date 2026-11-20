import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 70,
  defaults: {
    section: "Data models & exception handling",
  },
});

export const row = bindKotlinAuthRow(section);
