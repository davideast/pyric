import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAppCheckRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-swift',
  order: 30,
  defaults: {
    section: 'Token Notifications & Auto-Refresh',
  },
});

export const row = bindSwiftAppCheckRow(section);
