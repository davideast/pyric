import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-swift',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Attestation Providers',
  },
});

export const row = bindSwiftAppCheckRow(section);
