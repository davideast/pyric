import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-flutter',
  order: 20,
  defaults: {
    section: 'Standard & Limited-Use Token Lifecycle',
  },
});

export const row = bindFlutterAppCheckRow(section);
