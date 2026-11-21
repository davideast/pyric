import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-swift',
  order: 50,
  defaults: {
    section: 'Transport Security, App Check & Live-Mode Guards',
  },
});

export const row = bindSwiftCrashlyticsRow(section);
