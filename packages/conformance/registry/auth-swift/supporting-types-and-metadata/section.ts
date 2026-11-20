import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 60,
  defaults: {
    section: 'Supporting types & metadata',
  },
});

export const row = bindSwiftAuthRow(section);
