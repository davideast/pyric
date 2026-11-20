import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 30,
  defaults: {
    section: "`FirebaseAuth` — state observers & modern flows",
  },
});

export const row = bindKotlinAuthRow(section);
