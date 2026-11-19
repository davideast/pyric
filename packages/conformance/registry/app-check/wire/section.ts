import { defineRowSection } from '../../section-rows.ts';
import { bindAppCheckCddRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'app-check',
  order: 40,
  defaults: {
    section: 'Token exchange on the wire',
  },
});

export const row = bindAppCheckCddRow('app-check', section);
