import { defineRowSection } from '../../section-rows.ts';
import { bindWebCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics',
  order: 20,
  defaults: {
    section: 'Breadcrumbs, User Identity & Custom Keys',
  },
});

export const row = bindWebCrashlyticsRow(section);
