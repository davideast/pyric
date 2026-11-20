import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 100,
  defaults: {
    section: 'Error handling & wire codecs',
  },
});

export const row = bindFlutterAuthRow(section);
