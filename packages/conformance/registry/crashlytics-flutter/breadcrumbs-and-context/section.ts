import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-flutter',
  order: 20,
  defaults: {
    section: 'Breadcrumbs, User Identity & Custom Keys',
  },
});

export const row = bindFlutterCrashlyticsRow(section);
