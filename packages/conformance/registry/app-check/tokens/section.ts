import { defineRowSection } from '../../section-rows.ts';
import { bindAppCheckCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check',
  order: 20,
  defaults: {
    section: 'Tokens: `getToken`, `getLimitedUseToken`',
  },
});

export const row = bindAppCheckCddRow('app-check', section);
