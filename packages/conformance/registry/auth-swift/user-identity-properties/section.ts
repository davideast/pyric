import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 40,
  defaults: {
    section: '`User` — identity properties',
  },
});

export const row = bindSwiftAuthRow(section);
