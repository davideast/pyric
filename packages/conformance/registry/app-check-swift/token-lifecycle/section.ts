import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-swift',
  order: 20,
  defaults: {
    section: 'Standard & Limited-Use Token Lifecycle',
  },
});

export const row = bindSwiftAppCheckRow(section);
