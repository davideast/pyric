import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 20,
  defaults: {
    section: '`Auth` — authentication operations',
  },
});

export const row = bindSwiftAuthRow(section);
