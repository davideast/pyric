import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 10,
  defaults: {
    section: "`FirebaseAuth` — instance & lifecycle",
  },
});

export const row = bindKotlinAuthRow(section);
