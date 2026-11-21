import { defineRowSection } from '../../section-rows.ts';
import { bindWebCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Collection Configuration',
  },
});

export const row = bindWebCrashlyticsRow(section);
