import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-kotlin',
  order: 40,
  defaults: {
    section: 'Unsent Report Queue, Flush & State Inspection',
  },
});

export const row = bindKotlinCrashlyticsRow(section);
