import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-flutter',
  order: 30,
  defaults: {
    section: 'Token Streams & Auto-Refresh',
  },
});

export const row = bindFlutterAppCheckRow(section);
