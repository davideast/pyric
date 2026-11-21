import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-kotlin',
  order: 50,
  defaults: {
    section: 'Transport Security, App Check & Live-Mode Guards',
  },
});

export const row = bindKotlinCrashlyticsRow(section);
