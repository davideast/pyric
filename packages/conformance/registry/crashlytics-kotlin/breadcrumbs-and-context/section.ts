import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-kotlin',
  order: 20,
  defaults: {
    section: 'Breadcrumbs, User Identity & Custom Keys',
  },
});

export const row = bindKotlinCrashlyticsRow(section);
