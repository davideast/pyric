import { defineRowSection } from '../../section-rows.ts';
import { bindAppCheckCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check-admin',
  order: 50,
  defaults: {
    section: 'firebase-admin `getAppCheck()`',
  },
});

export const row = bindAppCheckCddRow('app-check-admin', section);
