import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 30,
  defaults: {
    section: '`Auth` — state listeners & reactive streams',
  },
});

export const row = bindSwiftAuthRow(section);
