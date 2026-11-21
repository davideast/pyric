import { defineRowSection } from '../../section-rows.ts';
import { bindWebCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics',
  order: 40,
  defaults: {
    section: 'Unsent Report Queue, Flush & State Inspection',
  },
});

export const row = bindWebCrashlyticsRow(section);
