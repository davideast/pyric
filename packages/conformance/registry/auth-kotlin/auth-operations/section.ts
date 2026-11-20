import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 20,
  defaults: {
    section: "`FirebaseAuth` — authentication operations",
  },
});

export const row = bindKotlinAuthRow(section);
