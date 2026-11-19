import { defineRowSection } from '../../section-rows.ts';
import { bindAppCheckCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check',
  order: 10,
  defaults: {
    section: '`initializeAppCheck(app, options)` and providers',
  },
});

export const row = bindAppCheckCddRow('app-check', section);
