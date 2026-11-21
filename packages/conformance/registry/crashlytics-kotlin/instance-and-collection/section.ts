import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-kotlin',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Collection Configuration',
  },
});

export const row = bindKotlinCrashlyticsRow(section);
