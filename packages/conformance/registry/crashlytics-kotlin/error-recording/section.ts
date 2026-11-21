import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-kotlin',
  order: 30,
  defaults: {
    section: 'Non-Fatal & Fatal Error Recording',
  },
});

export const row = bindKotlinCrashlyticsRow(section);
