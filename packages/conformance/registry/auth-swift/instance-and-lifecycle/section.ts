import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 10,
  defaults: {
    section: '`Auth` — instance & lifecycle',
  },
});

export const row = bindSwiftAuthRow(section);
