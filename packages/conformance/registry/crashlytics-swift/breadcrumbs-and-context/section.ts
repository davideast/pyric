import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-swift',
  order: 20,
  defaults: {
    section: 'Breadcrumbs, User Identity & Custom Keys',
  },
});

export const row = bindSwiftCrashlyticsRow(section);
