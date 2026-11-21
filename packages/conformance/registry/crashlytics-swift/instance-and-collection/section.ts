import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-swift',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Collection Configuration',
  },
});

export const row = bindSwiftCrashlyticsRow(section);
