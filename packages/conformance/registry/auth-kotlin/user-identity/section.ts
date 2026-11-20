import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 40,
  defaults: {
    section: "`FirebaseUser` — user identity & properties",
  },
});

export const row = bindKotlinAuthRow(section);
