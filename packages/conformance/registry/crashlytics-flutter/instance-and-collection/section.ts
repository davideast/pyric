import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-flutter',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Collection Configuration',
  },
});

export const row = bindFlutterCrashlyticsRow(section);
