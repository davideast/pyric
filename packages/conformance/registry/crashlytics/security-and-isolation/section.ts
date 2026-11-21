import { defineRowSection } from '../../section-rows.ts';
import { bindWebCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics',
  order: 50,
  defaults: {
    section: 'Transport Security, App Check & Live-Mode Guards',
  },
});

export const row = bindWebCrashlyticsRow(section);
