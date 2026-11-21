import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-flutter',
  order: 40,
  defaults: {
    section: 'Unsent Report Queue, Flush & State Inspection',
  },
});

export const row = bindFlutterCrashlyticsRow(section);
