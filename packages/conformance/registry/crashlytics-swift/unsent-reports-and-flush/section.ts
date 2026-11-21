import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-swift',
  order: 40,
  defaults: {
    section: 'Unsent Report Queue, Flush & State Inspection',
  },
});

export const row = bindSwiftCrashlyticsRow(section);
