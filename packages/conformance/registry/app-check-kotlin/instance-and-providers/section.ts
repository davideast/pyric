import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-kotlin',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Attestation Providers',
  },
});

export const row = bindKotlinAppCheckRow(section);
