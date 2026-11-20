import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 90,
  defaults: {
    section: 'Advanced auth & platform extensions',
  },
});

export const row = bindFlutterAuthRow(section);
