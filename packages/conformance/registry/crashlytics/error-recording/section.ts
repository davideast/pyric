import { defineRowSection } from '../../section-rows.ts';
import { bindWebCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics',
  order: 30,
  defaults: {
    section: 'Non-Fatal & Fatal Error Recording',
  },
});

export const row = bindWebCrashlyticsRow(section);
