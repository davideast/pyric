import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 60,
  defaults: {
    section: "`UserProfileChangeRequest` — profile mutation builder",
  },
});

export const row = bindKotlinAuthRow(section);
