import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftCrashlyticsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'crashlytics-swift',
  order: 30,
  defaults: {
    section: 'Non-Fatal & Fatal Error Recording',
  },
});

export const row = bindSwiftCrashlyticsRow(section);
