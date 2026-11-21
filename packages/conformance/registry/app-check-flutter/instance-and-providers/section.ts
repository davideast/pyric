import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-flutter',
  order: 10,
  defaults: {
    section: 'Delegate Scoping & Attestation Providers',
  },
});

export const row = bindFlutterAppCheckRow(section);
