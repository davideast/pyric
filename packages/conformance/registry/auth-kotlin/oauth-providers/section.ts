import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 90,
  defaults: {
    section: "OAuth providers & credential authentication",
  },
});

export const row = bindKotlinAuthRow(section);
