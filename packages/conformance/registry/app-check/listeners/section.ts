import { defineRowSection } from '../../section-rows.ts';
import { bindAppCheckCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check',
  order: 30,
  defaults: {
    section: 'Listeners and refresh: `onTokenChanged`, `setTokenAutoRefreshEnabled`',
  },
});

export const row = bindAppCheckCddRow('app-check', section);
