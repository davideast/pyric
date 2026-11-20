import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 90,
  defaults: {
    section: 'OAuth providers & credential authentication',
  },
});

export const row = bindSwiftAuthRow(section);
