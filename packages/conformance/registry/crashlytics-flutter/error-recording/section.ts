import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-flutter',
  order: 30,
  defaults: {
    section: 'Non-Fatal & Fatal Error Recording',
  },
});

export const row = bindFlutterCrashlyticsRow(section);
