import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 80,
  defaults: {
    section: 'Error handling',
  },
});

export const row = bindSwiftAuthRow(section);
