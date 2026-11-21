import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-flutter',
  order: 50,
  defaults: {
    section: 'Transport Security, App Check & Live-Mode Guards',
  },
});

export const row = bindFlutterCrashlyticsRow(section);
