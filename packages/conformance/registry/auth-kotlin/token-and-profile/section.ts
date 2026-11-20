import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 50,
  defaults: {
    section: "`FirebaseUser` — token & profile operations",
  },
});

export const row = bindKotlinAuthRow(section);
